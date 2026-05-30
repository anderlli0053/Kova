use std::path::{Path, PathBuf};

fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())
}

pub fn check_in_home(path: &Path) -> Result<(), String> {
    let home = home_dir()?;
    // On Windows, std::fs::canonicalize adds a \\?\ UNC prefix. The `path`
    // argument is already canonical, so home must also be canonicalized before
    // starts_with — otherwise the prefix mismatch causes the check to always
    // fail, blocking every file read/write on Windows.
    let canonical_home = std::fs::canonicalize(&home).unwrap_or(home);
    if path.starts_with(&canonical_home) {
        Ok(())
    } else {
        Err("Access denied: path is outside your home directory".to_string())
    }
}

// For reads the file must exist, so canonicalize resolves symlinks and traversal.
pub fn safe_read_path(path: &str) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("Failed to read file: {e}"))?;
    check_in_home(&canonical)?;
    Ok(canonical)
}

// For writes the file may not exist yet; canonicalize the parent instead.
pub fn safe_write_path(path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    let parent = p.parent().ok_or_else(|| "Invalid path: no parent directory".to_string())?;
    let filename = p.file_name().ok_or_else(|| "Invalid path: no filename".to_string())?;
    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|e| format!("Failed to write file: {e}"))?;
    let resolved = canonical_parent.join(filename);
    check_in_home(&resolved)?;
    Ok(resolved)
}

pub fn read(path: &str) -> Result<String, String> {
    let safe = safe_read_path(path)?;
    std::fs::read_to_string(&safe).map_err(|e| format!("Failed to read file: {e}"))
}

pub fn write(path: &str, content: &str) -> Result<(), String> {
    let safe = safe_write_path(path)?;
    atomic_write(&safe, content.as_bytes())
}

pub fn write_bytes(path: &str, bytes: &[u8]) -> Result<(), String> {
    let safe = safe_write_path(path)?;
    atomic_write(&safe, bytes)
}

// Writes `data` to `dest` via a sibling temp file then an atomic rename.
// Keeps the temp file in the same directory as `dest` so the rename is
// guaranteed to be on the same filesystem (required on Windows).
// On POSIX the rename is atomic; on Windows it is near-atomic (the OS
// replaces the destination in a single kernel transaction on NTFS).
fn atomic_write(dest: &std::path::Path, data: &[u8]) -> Result<(), String> {
    let tmp = dest.with_file_name(format!(
        "{}.kova-tmp",
        dest.file_name().unwrap_or_default().to_string_lossy()
    ));
    std::fs::write(&tmp, data)
        .map_err(|e| format!("Failed to write file: {e}"))?;
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to save file: {e}")
    })
}

#[cfg(test)]
mod tests {
    // These tests use Windows-style paths with backslash separators and the
    // \\?\ UNC prefix that std::fs::canonicalize adds on Windows. They only
    // make sense on Windows because backslash is not a path separator on
    // Linux/macOS, so Path would treat the whole string as one component.
    #[cfg(target_os = "windows")]
    mod windows_unc {
        use std::path::Path;

        #[test]
        fn unc_prefix_mismatch_was_the_bug() {
            let bare_home      = Path::new(r"C:\Users\ross");
            let canonical_path = Path::new(r"\\?\C:\Users\ross\Documents\file.md");
            // Old behaviour: bare home vs canonical path — always false.
            assert!(!canonical_path.starts_with(bare_home));
        }

        #[test]
        fn unc_prefix_matches_when_home_is_also_canonical() {
            let canonical_home = Path::new(r"\\?\C:\Users\ross");
            let canonical_path = Path::new(r"\\?\C:\Users\ross\Documents\file.md");
            // Fixed behaviour: both canonical — starts_with works correctly.
            assert!(canonical_path.starts_with(canonical_home));
        }

        #[test]
        fn traversal_still_blocked_after_fix() {
            let canonical_home = Path::new(r"\\?\C:\Users\ross");
            let outside        = Path::new(r"\\?\C:\Users\other\secret.txt");
            assert!(!outside.starts_with(canonical_home));
        }
    }
}
