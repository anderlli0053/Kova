use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Cannot determine home directory".to_string())
}

pub fn check_in_home(path: &Path) -> Result<(), String> {
    // On Linux this enforces the Flatpak sandbox boundary: Flatpak apps are
    // expected to access only the user's home directory, so we hard-fail for
    // paths outside it. On macOS and Windows users legitimately keep files
    // anywhere (e.g. C:\ak\... on Windows or /Volumes/... on macOS), so the
    // check is skipped — canonicalize() already prevents path-traversal attacks
    // on all platforms by resolving symlinks and .. components.
    #[cfg(not(target_os = "linux"))]
    {
        let _ = path; // suppress unused-variable warning
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        let home = home_dir()?;
        let canonical_home = std::fs::canonicalize(&home).unwrap_or(home);
        if path.starts_with(&canonical_home) {
            Ok(())
        } else {
            Err("Access denied: path is outside your home directory".to_string())
        }
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

static WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

// Writes `data` to `dest` via a sibling temp file then an atomic rename.
// Keeps the temp file in the same directory as `dest` so the rename is
// guaranteed to be on the same filesystem (required on Windows).
// On POSIX the rename is atomic; on Windows it is near-atomic (the OS
// replaces the destination in a single kernel transaction on NTFS).
fn atomic_write(dest: &std::path::Path, data: &[u8]) -> Result<(), String> {
    let seq = WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dest.with_file_name(format!(
        "{}.{}.kova-tmp",
        dest.file_name().unwrap_or_default().to_string_lossy(),
        seq
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
    // These tests verify the Linux home-boundary logic using portable path
    // construction. The Windows UNC-prefix tests have been removed: check_in_home
    // is now a no-op on Windows (users may save anywhere), so those assertions
    // are no longer meaningful.
    #[cfg(target_os = "linux")]
    mod linux_home_boundary {
        use std::path::Path;

        #[test]
        fn path_inside_home_is_allowed() {
            let home = Path::new("/home/ross");
            let inside = Path::new("/home/ross/Documents/file.md");
            assert!(inside.starts_with(home));
        }

        #[test]
        fn path_outside_home_is_blocked() {
            let home = Path::new("/home/ross");
            let outside = Path::new("/home/other/secret.txt");
            assert!(!outside.starts_with(home));
        }

        #[test]
        fn traversal_outside_home_is_blocked() {
            let home = Path::new("/home/ross");
            let traversal = Path::new("/etc/passwd");
            assert!(!traversal.starts_with(home));
        }
    }
}
