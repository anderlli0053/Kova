use crate::{file_io, watcher};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, State};

// --- Wake lock (prevent display sleep during presentations) ---

#[cfg(target_os = "macos")]
static CAFFEINATE: Mutex<Option<std::process::Child>> = Mutex::new(None);

#[cfg(target_os = "linux")]
static SCREENSAVER_COOKIE: Mutex<Option<u32>> = Mutex::new(None);

#[cfg(target_os = "windows")]
extern "system" {
    fn SetThreadExecutionState(esFlags: u32) -> u32;
}

// Sender whose drop signals the wake-lock thread to exit.
#[cfg(target_os = "windows")]
static WIN_WAKE_TX: Mutex<Option<std::sync::mpsc::SyncSender<()>>> = Mutex::new(None);

#[tauri::command]
#[allow(unused_variables)]
pub fn set_wake_lock(active: bool) {
    #[cfg(target_os = "macos")]
    {
        let mut guard = CAFFEINATE.lock().unwrap();
        if active {
            if guard.is_none() {
                // -d: prevent display sleep; -i: prevent idle sleep (also suppresses App Nap,
                // which can throttle background WebViews after ~10 min of inactivity).
                if let Ok(child) = std::process::Command::new("caffeinate").args(["-d", "-i"]).spawn() {
                    *guard = Some(child);
                }
            }
        } else if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    #[cfg(target_os = "linux")]
    {
        use gio::prelude::*;
        let mut cookie_guard = SCREENSAVER_COOKIE.lock().unwrap();
        if active && cookie_guard.is_none() {
            if let Ok(conn) = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE) {
                let args = ("Kova", "Presentation mode").to_variant();
                if let Ok(result) = conn.call_sync(
                    Some("org.freedesktop.ScreenSaver"),
                    "/org/freedesktop/ScreenSaver",
                    "org.freedesktop.ScreenSaver",
                    "Inhibit",
                    Some(&args),
                    None,
                    gio::DBusCallFlags::NONE,
                    -1,
                    gio::Cancellable::NONE,
                ) {
                    if let Some((cookie,)) = result.get::<(u32,)>() {
                        *cookie_guard = Some(cookie);
                    }
                }
            }
        } else if !active {
            if let Some(c) = cookie_guard.take() {
                if let Ok(conn) = gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE) {
                    let args = (c,).to_variant();
                    let _ = conn.call_sync(
                        Some("org.freedesktop.ScreenSaver"),
                        "/org/freedesktop/ScreenSaver",
                        "org.freedesktop.ScreenSaver",
                        "UnInhibit",
                        Some(&args),
                        None,
                        gio::DBusCallFlags::NONE,
                        -1,
                        gio::Cancellable::NONE,
                    );
                }
            }
        }
    }

    // SetThreadExecutionState is per-thread; calling it on a Tokio pool thread
    // whose lifetime we don't control would let the inhibit lapse silently when
    // that thread is recycled. A dedicated persistent thread holds the state for
    // the full duration of the presentation and re-asserts every 30 s as
    // recommended by the Windows docs.
    #[cfg(target_os = "windows")]
    {
        let mut guard = WIN_WAKE_TX.lock().unwrap();
        if active {
            if guard.is_none() {
                let (tx, rx) = std::sync::mpsc::sync_channel::<()>(0);
                *guard = Some(tx);
                std::thread::spawn(move || unsafe {
                    const ES_CONTINUOUS: u32 = 0x80000000;
                    const ES_DISPLAY_REQUIRED: u32 = 0x00000002;
                    SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED);
                    loop {
                        match rx.recv_timeout(std::time::Duration::from_secs(30)) {
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                                SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED);
                            }
                            _ => break,
                        }
                    }
                    SetThreadExecutionState(ES_CONTINUOUS);
                });
            }
        } else {
            guard.take(); // drop sender → thread's recv returns Disconnected → exits
        }
    }
}

/// Opens a path in the native file manager (Finder / Nautilus / Explorer).
/// Uses platform process commands directly rather than tauri-plugin-opener,
/// which requires path scopes to be configured before it works on macOS.
#[tauri::command]
pub fn show_in_file_manager(path: String) -> Result<(), String> {
    // Canonicalize (resolves symlinks/traversal) and enforce home boundary.
    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("Invalid path: {e}"))?;
    file_io::check_in_home(&canonical)?;

    let is_file = canonical.is_file();

    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if is_file {
            cmd.arg("-R"); // reveal file in Finder rather than opening it
        }
        cmd.arg(&canonical).spawn().map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        // xdg-open handles both files (opens parent dir) and directories
        let target = if is_file {
            canonical.parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| canonical.to_string_lossy().into_owned())
        } else {
            canonical.to_string_lossy().into_owned()
        };
        std::process::Command::new("xdg-open")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("explorer");
        if is_file {
            // Strip the \\?\ extended-length prefix that canonicalize adds on Windows
            // — Explorer /select does not recognise UNC-prefixed paths.
            let path_str = canonical.to_string_lossy();
            let clean = path_str.strip_prefix(r"\\?\").unwrap_or(&path_str);
            cmd.arg(format!("/select,\"{}\"", clean));
        } else {
            cmd.arg(&canonical);
        }
        cmd.spawn().map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Move the audience window to the correct external monitor then fullscreen it.
///
/// On Linux/Wayland setPosition is a no-op — the compositor controls window
/// placement and ignores application-supplied coordinates. The only reliable
/// protocol is xdg_toplevel_set_fullscreen(output), exposed through GTK3 as
/// gtk_window_fullscreen_on_monitor(screen, n).
///
/// On macOS and Windows the classic set_position → sleep → set_fullscreen
/// sequence works fine because those compositors honour the move.
///
/// `x`/`y` are logical pixels (physical ÷ scale factor from Tauri).
/// `physical_x`/`physical_y` are raw physical pixel coordinates, used on X11
/// where GDK may operate in physical-pixel screen coordinates.
#[tauri::command]
pub async fn setup_audience_window(
    app: AppHandle,
    x: f64,
    y: f64,
    _physical_x: f64,
    _physical_y: f64,
) -> Result<(), String> {
    // Wait for the audience window to appear in the manager, up to 5 s.
    // This replaces a single fixed sleep: on fast machines we proceed sooner;
    // on slow/loaded machines we don't give up prematurely.
    let found = 'wait: {
        for _ in 0..50 {
            if app.get_webview_window("audience").is_some() {
                break 'wait true;
            }
            tauri::async_runtime::spawn_blocking(|| {
                std::thread::sleep(std::time::Duration::from_millis(100));
            })
            .await
            .ok();
        }
        false
    };
    if !found {
        return Err("audience window did not appear within 5 s".into());
    }
    // Brief extra pause to allow the native GTK/NS/HWND handle to be realized
    // after the window first appears in the manager.
    tauri::async_runtime::spawn_blocking(|| {
        std::thread::sleep(std::time::Duration::from_millis(150));
    })
    .await
    .ok();

    #[cfg(target_os = "linux")]
    {
        #[cfg(debug_assertions)]
        eprintln!("[kova] setup_audience_window: logical x={x:.0} y={y:.0}  physical x={_physical_x:.0} y={_physical_y:.0}");
        let app2 = app.clone();
        app.run_on_main_thread(move || {
            use gtk::prelude::GtkWindowExt;
            use gdk::prelude::MonitorExt;

            let win = match app2.get_webview_window("audience") {
                Some(w) => w,
                None => {
                    #[cfg(debug_assertions)]
                    eprintln!("[kova] audience window not found in GTK thread");
                    return;
                }
            };
            let gtk_win = match win.gtk_window() {
                Ok(w) => w,
                Err(e) => {
                    #[cfg(debug_assertions)]
                    eprintln!("[kova] gtk_window() failed: {e}");
                    return;
                }
            };
            let display = match gdk::Display::default() {
                Some(d) => d,
                None => {
                    #[cfg(debug_assertions)]
                    eprintln!("[kova] no default GDK display");
                    return;
                }
            };

            let screen  = display.default_screen();
            let n       = display.n_monitors();

            #[cfg(debug_assertions)]
            {
                let primary = display.primary_monitor();
                eprintln!("[kova] GDK sees {n} monitor(s):");
                for i in 0..n {
                    if let Some(m) = display.monitor(i) {
                        let g = m.geometry();
                        let is_primary = primary.as_ref()
                            .map(|p| p.geometry() == g)
                            .unwrap_or(false);
                        eprintln!("[kova]   [{i}] pos=({},{}) size={}×{} primary={is_primary}",
                            g.x(), g.y(), g.width(), g.height());
                    }
                }
            }

            // GDK coordinate space depends on the display backend:
            //   Wayland — logical (compositor) units, matching `x`/`y`.
            //   X11 without GDK_SCALE — physical pixels, matching `physical_x`/`physical_y`.
            //   X11 with GDK_SCALE — logical pixels, matching `x`/`y`.
            // Try physical coordinates first on X11 (they're always valid there),
            // then fall back to logical. On Wayland only use logical.
            let display_name = display.name();
            let is_wayland = display_name.to_ascii_lowercase().contains("wayland");

            let candidates: &[(i32, i32)] = if is_wayland {
                &[(x as i32 + 1, y as i32 + 1)]
            } else {
                &[
                    (_physical_x as i32 + 1, _physical_y as i32 + 1),
                    (x as i32 + 1, y as i32 + 1),
                ]
            };

            let found_monitor = candidates.iter().find_map(|&(cx, cy)| {
                let m = display.monitor_at_point(cx, cy)?;
                #[cfg(debug_assertions)]
                {
                    let g = m.geometry();
                    eprintln!("[kova] monitor_at_point({cx},{cy}) → ({},{}) {}×{}",
                        g.x(), g.y(), g.width(), g.height());
                }
                Some(m)
            });

            let target: i32 = if let Some(mon) = found_monitor {
                let geom = mon.geometry();
                (0..n)
                    .find(|&i| display.monitor(i).map(|m| m.geometry() == geom).unwrap_or(false))
                    .unwrap_or(0)
            } else {
                // Proximity fallback: pick the monitor whose origin is closest to the
                // logical target point. Works regardless of primary-monitor availability
                // (Wayland exposes no primary) and regardless of DPI configuration.
                #[cfg(debug_assertions)]
                eprintln!("[kova] monitor_at_point returned None; using proximity fallback");
                let (tx, ty) = (x as i32, y as i32);
                (0..n)
                    .min_by_key(|&i| {
                        display.monitor(i)
                            .map(|m| {
                                let g = m.geometry();
                                let dx = (g.x() - tx) as i64;
                                let dy = (g.y() - ty) as i64;
                                dx * dx + dy * dy
                            })
                            .unwrap_or(i64::MAX)
                    })
                    .unwrap_or(0)
            };

            #[cfg(debug_assertions)]
            eprintln!("[kova] calling fullscreen_on_monitor({target})");
            gtk_win.fullscreen_on_monitor(&screen, target);
        })
        .map_err(|e| format!("run_on_main_thread failed: {e}"))?;
        return Ok(());
    }

    #[cfg(not(target_os = "linux"))]
    {
        // macOS / Windows: move to the external monitor, pause, then go fullscreen.
        if let Some(win) = app.get_webview_window("audience") {
            win.set_position(tauri::LogicalPosition::<f64>::new(x, y))
                .map_err(|e: tauri::Error| e.to_string())?;
        }
        tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(std::time::Duration::from_millis(250));
        })
        .await
        .ok();
        if let Some(win) = app.get_webview_window("audience") {
            win.set_fullscreen(true).map_err(|e: tauri::Error| e.to_string())?;
        }
        Ok(())
    }
}

/// Returns a formatted string describing monitor layout from both Tauri's and
/// GDK's perspective. Call from the browser devtools console:
///   await window.__TAURI__.core.invoke('debug_monitors')
#[tauri::command]
#[cfg_attr(not(debug_assertions), allow(unreachable_code, unused_variables))]
pub fn debug_monitors(app: AppHandle) -> String {
    #[cfg(not(debug_assertions))]
    return String::new();

    let mut out = String::new();

    match app.primary_monitor() {
        Ok(Some(pm)) => out.push_str(&format!("Tauri primary: {:?}\n", pm.name())),
        Ok(None)     => out.push_str("Tauri primary: (none)\n"),
        Err(e)       => out.push_str(&format!("Tauri primary error: {e}\n")),
    }
    match app.available_monitors() {
        Ok(monitors) => {
            for (i, m) in monitors.iter().enumerate() {
                out.push_str(&format!(
                    "Tauri[{i}]: {:?}  pos=({},{})  {}×{}  scale={:.1}\n",
                    m.name(),
                    m.position().x, m.position().y,
                    m.size().width, m.size().height,
                    m.scale_factor(),
                ));
            }
        }
        Err(e) => out.push_str(&format!("Tauri monitors error: {e}\n")),
    }

    #[cfg(target_os = "linux")]
    {
        use gdk::prelude::MonitorExt;
        out.push('\n');
        if let Some(display) = gdk::Display::default() {
            let n       = display.n_monitors();
            let primary = display.primary_monitor();
            out.push_str(&format!("GDK: {n} monitor(s)\n"));
            for i in 0..n {
                if let Some(m) = display.monitor(i) {
                    let g = m.geometry();
                    let is_primary = primary.as_ref()
                        .map(|p| p.geometry() == g)
                        .unwrap_or(false);
                    out.push_str(&format!(
                        "GDK[{i}]: pos=({},{})  {}×{}  primary={is_primary}\n",
                        g.x(), g.y(), g.width(), g.height()
                    ));
                }
            }
        } else {
            out.push_str("GDK: no default display\n");
        }
    }

    out
}

// Consolidating both watcher fields into one Mutex eliminates the TOCTOU window
// between separate current_file and watcher lock/unlock cycles.
pub struct WatchState {
    pub current_file: Option<PathBuf>,
    pub watcher: Option<notify::RecommendedWatcher>,
}

pub struct AppState {
    pub watch: Mutex<WatchState>,
    /// Set once the frontend has resolved the unsaved-changes prompt (or there
    /// was nothing to confirm) for an in-flight app-level quit. Checked by the
    /// `RunEvent::ExitRequested` handler in lib.rs so the retried `app.exit()`
    /// below isn't intercepted a second time.
    pub exit_confirmed: std::sync::atomic::AtomicBool,
    /// File paths from macOS "Open With" / double-click that arrived (via
    /// `RunEvent::Opened`) before the frontend mounted its listener. Drained
    /// once on startup by `take_pending_open`.
    pub pending_open: Mutex<Vec<String>>,
    /// Unix-millisecond deadline before which the watcher should suppress
    /// file-changed events — set by write_file to swallow events caused by
    /// Kova's own atomic rename rather than a genuine external edit.
    pub own_write_suppress_until: Arc<AtomicU64>,
}

/// Drain file paths that macOS delivered before the webview was ready to listen.
#[tauri::command]
pub fn take_pending_open(state: State<'_, AppState>) -> Vec<String> {
    std::mem::take(&mut *state.pending_open.lock().unwrap())
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    file_io::read(&path)
}

#[tauri::command]
pub fn write_file(path: String, content: String, state: State<'_, AppState>) -> Result<(), String> {
    // Stamp a 500 ms suppression window before the rename so the watcher
    // ignores the inotify/FSEvents events caused by our own atomic write.
    let until = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64 + 500;
    state.own_write_suppress_until.store(until, Ordering::Relaxed);
    file_io::write(&path, &content)
}

#[tauri::command]
pub fn start_watching(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    // Validate and canonicalise before watching — same boundary check applied to
    // every other file command, preventing watching of arbitrary system files.
    let path_buf = file_io::safe_read_path(&path)?;

    let mut s = state.watch.lock().unwrap_or_else(|e| e.into_inner());
    // Drop previous watcher atomically before creating a new one.
    // Both fields are updated inside the same lock, preventing divergence.
    s.watcher = None;
    let suppress = Arc::clone(&state.own_write_suppress_until);
    let w = watcher::create(app, path_buf.clone(), suppress).map_err(|e| e.to_string())?;
    s.current_file = Some(path_buf);
    s.watcher = Some(w);

    Ok(())
}

#[tauri::command]
pub fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    let old = file_io::safe_read_path(&old_path)?;
    // safe_write_path canonicalises the parent directory, resolving any `..`
    // components before the home-boundary check runs.  Using PathBuf::from +
    // check_in_home directly allowed traversal because starts_with matches
    // components lexically without normalising `..`.
    let new = file_io::safe_write_path(&new_path)?;
    std::fs::rename(&old, &new).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stop_watching(state: State<'_, AppState>) {
    let mut s = state.watch.lock().unwrap_or_else(|e| e.into_inner());
    s.watcher = None;
    s.current_file = None;
}

// Sanitise a filename stem: replace whitespace and characters that break Markdown
// link syntax with underscores.
fn sanitise_stem(raw: &str) -> String {
    raw.chars()
        .map(|c| if c.is_whitespace() || matches!(c, '(' | ')' | '[' | ']' | '"' | '\'') { '_' } else { c })
        .collect()
}

// Validate dest_dir, create assets/ subdirectory, and return its path.
fn prepare_assets_dir(dest_dir: &str) -> Result<std::path::PathBuf, String> {
    let canonical = std::fs::canonicalize(dest_dir)
        .map_err(|e| format!("Cannot access destination directory: {e}"))?;
    file_io::check_in_home(&canonical)?;
    let assets_dir = canonical.join("assets");
    std::fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("Cannot create assets dir: {e}"))?;
    Ok(assets_dir)
}

// Write `bytes` into `assets_dir` under `{stem}.{ext}`, appending a numeric
// suffix on name collisions. Returns the final filename.
fn write_bytes_to_assets(bytes: &[u8], stem: &str, ext: &str, assets_dir: &std::path::Path) -> Result<String, String> {
    let mut name = format!("{stem}.{ext}");
    let mut counter = 1u32;
    loop {
        if counter > 10_000 {
            return Err("Too many files with the same name in assets/".into());
        }
        let dest = assets_dir.join(&name);
        if !dest.exists() {
            std::fs::write(&dest, bytes)
                .map_err(|e| format!("Cannot write asset: {e}"))?;
            return Ok(name);
        }
        name = format!("{stem}-{counter}.{ext}");
        counter += 1;
    }
}

/// Copies `src` into `{dest_dir}/assets/`, creating the directory if needed.
/// Returns the final filename (e.g. "screenshot.png") so the caller can
/// insert a relative `assets/<filename>` reference in the document.
/// If a file with the same name already exists, appends a numeric suffix.
#[tauri::command]
pub fn copy_image_to_assets(src: String, dest_dir: String) -> Result<String, String> {
    let src_path = file_io::safe_read_path(&src)?;
    let raw_stem = src_path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let ext      = src_path.extension().and_then(|s| s.to_str()).unwrap_or("png");
    let stem     = sanitise_stem(raw_stem);
    let assets_dir = prepare_assets_dir(&dest_dir)?;

    // Use std::fs::copy to preserve file metadata (timestamps, permissions).
    let mut name = format!("{stem}.{ext}");
    let mut counter = 1u32;
    loop {
        if counter > 10_000 {
            return Err("Too many files with the same name in assets/".into());
        }
        let dest = assets_dir.join(&name);
        if !dest.exists() {
            std::fs::copy(&src_path, &dest)
                .map_err(|e| format!("Cannot copy image: {e}"))?;
            return Ok(name);
        }
        name = format!("{stem}-{counter}.{ext}");
        counter += 1;
    }
}

/// Scans a markdown file for local `assets/…` references and returns them as
/// relative paths (e.g. `["assets/foo.png", "assets/bar.jpg"]`).
#[tauri::command]
pub fn scan_asset_refs(file_path: String) -> Result<Vec<String>, String> {
    let content = file_io::read(&file_path)?;
    let mut refs: std::collections::HashSet<String> = std::collections::HashSet::new();
    let needle = "assets/";
    let mut start = 0usize;
    while let Some(rel) = content[start..].find(needle) {
        let abs = start + rel;
        let rest = &content[abs..];
        let end = rest
            .find(|c: char| matches!(c, ')' | '"' | '\'' | ' ' | '\t' | '\n' | '\r'))
            .unwrap_or(rest.len());
        if end > needle.len() {
            refs.insert(rest[..end].to_string());
        }
        start = abs + 1; // advance past this match to avoid re-scanning
    }
    Ok(refs.into_iter().collect())
}

/// Writes `content` to `dest_path` and, if `asset_refs` is non-empty,
/// copies those asset files (resolved relative to `src_path`) into an
/// `assets/` folder next to the destination.
#[tauri::command]
pub fn copy_file_with_assets(
    src_path: String,
    content: String,
    dest_path: String,
    asset_refs: Vec<String>,
) -> Result<(), String> {
    let safe_src  = file_io::safe_read_path(&src_path)?;
    let safe_dest = file_io::safe_write_path(&dest_path)?;

    std::fs::write(&safe_dest, &content)
        .map_err(|e| format!("Cannot write destination: {e}"))?;

    if asset_refs.is_empty() {
        return Ok(());
    }

    let src_dir  = safe_src.parent().ok_or("Invalid source path")?;
    let dest_dir = safe_dest.parent().ok_or("Invalid dest path")?;

    for asset_ref in &asset_refs {
        let src_asset  = src_dir.join(asset_ref);
        let dest_asset = dest_dir.join(asset_ref);
        // Create any intermediate directories the relative path requires.
        if let Some(parent) = dest_asset.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create dir for {asset_ref}: {e}"))?;
        }
        let safe_src_asset = file_io::safe_read_path(
            src_asset.to_str()
                .ok_or_else(|| format!("Asset path contains non-UTF-8 characters: {src_asset:?}"))?
        )?;
        let safe_dest_asset = file_io::safe_write_path(
            dest_asset.to_str()
                .ok_or_else(|| format!("Asset dest path contains non-UTF-8 characters: {dest_asset:?}"))?
        )?;
        std::fs::copy(&safe_src_asset, &safe_dest_asset)
            .map_err(|e| format!("Cannot copy {asset_ref}: {e}"))?;
    }

    Ok(())
}

/// Decodes base64-encoded data and writes it as binary to the given path.
#[tauri::command]
pub fn write_file_bytes(path: String, data: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("Base64 decode error: {e}"))?;
    file_io::write_bytes(&path, &bytes)
}

/// Reads a binary file and returns its contents as standard base64.
/// Used by the PPTX import pipeline to hand raw bytes to the TypeScript parser.
#[tauri::command]
pub fn read_file_b64(path: String) -> Result<String, String> {
    use base64::Engine;
    let safe = file_io::safe_read_path(&path)?;
    let ext = safe.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    let allowed = matches!(
        ext.as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "svg" | "webp" | "bmp" | "avif" | "tif" | "tiff" | "ico"
            | "pptx")
    );
    if !allowed {
        return Err("Access denied: only image and presentation files may be read as base64".to_string());
    }
    let bytes = std::fs::read(&safe).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Writes base64-encoded bytes to `{dest_dir}/assets/{filename}`.
/// Creates the assets directory if absent. Appends a numeric suffix on name conflicts.
/// Returns the final filename (e.g. "pptx_slide1_img1.png").
#[tauri::command]
pub fn write_asset_bytes(data: String, filename: String, dest_dir: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("Base64 decode error: {e}"))?;
    let path     = std::path::Path::new(&filename);
    let raw_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("image");
    let ext      = path.extension().and_then(|s| s.to_str()).unwrap_or("png");
    let stem     = sanitise_stem(raw_stem);
    let assets_dir = prepare_assets_dir(&dest_dir)?;
    write_bytes_to_assets(&bytes, &stem, ext, &assets_dir)
}

const DEFAULT_KEYBINDINGS: &str = "\
# Kova — Keyboard Shortcuts
# ─────────────────────────────────────────────────────────────────────────────
# Edit this file to customise keyboard shortcuts, then restart Kova.
#
# Format:   action: modifier+key
# Modifiers (combine with +):  ctrl  shift  alt
#
# Available actions:
#   new_file    open_file    save    save_as    focus_mode

new_file:   ctrl+n
open_file:  ctrl+o
save:       ctrl+s
save_as:    ctrl+shift+s
focus_mode: ctrl+shift+f
";

/// Reads keybindings.yaml from the platform config dir, creating it from defaults if absent.
/// Returns (absolute_path, yaml_content).
#[tauri::command]
pub fn load_keybindings(app: AppHandle) -> Result<(String, String), String> {
    use tauri::Manager;
    let config_dir = app.path().config_dir().map_err(|e| e.to_string())?.join("kova");
    let path = config_dir.join("keybindings.yaml");

    if !path.exists() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, DEFAULT_KEYBINDINGS).map_err(|e| e.to_string())?;
    }

    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok((path.to_string_lossy().into_owned(), content))
}

const EXAMPLE_THEME: &str = "\
# Kova Theme — Example
# ─────────────────────────────────────────────────────────────────────────────
# Copy this file, rename it, and edit the values to create a custom theme.
# Place .yaml files in this folder and restart Kova to load them.
# Only include the properties you want to override — everything else inherits
# from the built-in defaults.
#
# Colour values accept any valid CSS colour: #rrggbb, rgb(), hsl(), etc.

name: My Custom Theme

colors:
  primary:    \"#1B3A5C\"   # title/section slide background, strong accents
  accent:     \"#2563EB\"   # links, highlights, progress bars
  background: \"#ffffff\"   # default slide background
  text:       \"#1a1a1a\"   # body text
  title_text: \"#ffffff\"   # text on title and section slides
  section_bg: \"#E8F0FE\"   # section divider background
  code_bg:    \"#F5F7FA\"   # code block background

fonts:
  title: \"Inter, 'Helvetica Neue', Arial, sans-serif\"
  body:  \"Inter, 'Helvetica Neue', Arial, sans-serif\"
  code:  \"'JetBrains Mono', 'Fira Code', monospace\"

layout:
  title_align:   center      # center | left | bottom-left
  heading_align: left        # left | center
  decoration:    none        # none | dots | grid | diagonal | bar-left

footer:
  show:              false
  text:              \"{title} — {slide_number} / {total}\"
  show_slide_number: true

header:
  show: false
  text: \"\"
";

/// Returns (themes_dir_path, entries) where each entry is
/// (filename_without_extension, yaml_content).
/// Creates the platform config themes dir and an example file on first run.
#[tauri::command]
pub fn load_custom_themes(app: AppHandle) -> Result<(String, Vec<(String, String)>), String> {
    use tauri::Manager;
    let config_dir = app.path().config_dir().map_err(|e| e.to_string())?.join("kova");
    let themes_dir = config_dir.join("themes");
    let dir_str = themes_dir.to_string_lossy().into_owned();

    if !themes_dir.exists() {
        std::fs::create_dir_all(&themes_dir).map_err(|e| e.to_string())?;
        std::fs::write(themes_dir.join("example.yaml"), EXAMPLE_THEME)
            .map_err(|e| e.to_string())?;
        return Ok((dir_str, vec![]));
    }

    let mut result = Vec::new();
    let entries = std::fs::read_dir(&themes_dir).map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext != "yaml" && ext != "yml" {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("custom")
            .to_string();
        if id == "example" {
            continue; // never load the template as a real theme
        }
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        result.push((id, content));
    }

    Ok((dir_str, result))
}

/// Writes a theme YAML file to the platform config themes dir (remote install).
#[tauri::command]
pub fn save_theme(app: AppHandle, id: String, yaml: String) -> Result<(), String> {
    use tauri::Manager;
    if id.is_empty() || !id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid theme id".into());
    }
    let themes_dir = app.path().config_dir().map_err(|e| e.to_string())?.join("kova").join("themes");
    std::fs::create_dir_all(&themes_dir).map_err(|e| e.to_string())?;
    let path = themes_dir.join(format!("{id}.yaml"));
    std::fs::write(path, yaml).map_err(|e| e.to_string())?;
    Ok(())
}

/// Removes a theme YAML file from the platform config themes dir (remote uninstall). Silent if file absent.
#[tauri::command]
pub fn delete_theme(app: AppHandle, id: String) -> Result<(), String> {
    use tauri::Manager;
    if id.is_empty() || !id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid theme id".into());
    }
    let path = app.path().config_dir().map_err(|e| e.to_string())?.join("kova")
        .join("themes").join(format!("{id}.yaml"));
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Downloads a font file from `url`, verifies its SHA-256, and caches it at
/// `~/.kova/themes/fonts/<sha256>.woff2`.  Idempotent — if the file is already
/// present the download is skipped and the cached path is returned immediately.
#[tauri::command]
pub async fn download_and_cache_font(
    app: AppHandle,
    url: String,
    sha256: String,
) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use tauri::Manager;

    // URL must be HTTPS to prevent cleartext interception.
    if !url.starts_with("https://") {
        return Err("font URL must use HTTPS".into());
    }

    // sha256 must be exactly 64 lowercase hex chars — used as the filename,
    // so this also prevents any path-traversal via crafted hash strings.
    if sha256.len() != 64 || !sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("sha256 must be a 64-character hex string".into());
    }

    let fonts_dir = app
        .path()
        .config_dir()
        .map_err(|e| e.to_string())?
        .join("kova")
        .join("themes")
        .join("fonts");

    std::fs::create_dir_all(&fonts_dir).map_err(|e| e.to_string())?;

    let dest = fonts_dir.join(format!("{sha256}.woff2"));

    if dest.exists() {
        return Ok(dest.to_string_lossy().into_owned());
    }

    const MAX_FONT_BYTES: u64 = 20 * 1024 * 1024; // 20 MB

    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("download failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("download failed: HTTP {}", response.status()));
    }

    if response.content_length().unwrap_or(0) > MAX_FONT_BYTES {
        return Err("font file too large (max 20 MB)".into());
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("download failed: {e}"))?;

    if bytes.len() as u64 > MAX_FONT_BYTES {
        return Err("font file too large (max 20 MB)".into());
    }

    // Verify integrity before writing to disk.
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != sha256 {
        return Err(format!(
            "integrity check failed — expected {sha256}, got {actual}"
        ));
    }

    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;

    Ok(dest.to_string_lossy().into_owned())
}

/// Returns true if the running installation supports in-place updates.
/// On Linux this requires AppImage — deb/rpm users must update via their package manager.
#[tauri::command]
pub fn can_self_update() -> bool {
    if cfg!(target_os = "linux") {
        std::env::var("APPIMAGE").is_ok()
    } else {
        true
    }
}

#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

/// Called by the frontend once the unsaved-changes prompt for an app-level
/// quit (Cmd+Q, Dock Quit, etc.) has been resolved — either the user chose to
/// discard/save, or there was nothing to confirm. Marks the exit confirmed so
/// the `RunEvent::ExitRequested` handler in lib.rs lets the retried `app.exit()`
/// through instead of asking again, then triggers the actual exit.
#[tauri::command]
pub fn confirm_exit(app: AppHandle, state: State<'_, AppState>) {
    state.exit_confirmed.store(true, std::sync::atomic::Ordering::SeqCst);
    // tauri-plugin-window-state normally saves on each window's CloseRequested
    // event, but this exit path (app.exit()) goes through RunEvent::ExitRequested
    // instead — whether that still fires CloseRequested for every open window
    // first isn't a guarantee this code wants to depend on, so save explicitly
    // here too. Harmless if the plugin's own hook also fires for the same exit.
    use tauri_plugin_window_state::{AppHandleExt, StateFlags};
    let _ = app.save_window_state(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED);
    app.exit(0);
}

/// Reads the system clipboard and returns the image as a base64-encoded PNG string.
/// On Linux this uses the GTK clipboard (must run on the GTK main thread).
/// Returns Err when the clipboard contains no image or on unsupported platforms.
#[tauri::command]
pub async fn read_clipboard_image(app: AppHandle) -> Result<String, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();

    app.run_on_main_thread(move || {
        #[cfg(target_os = "linux")]
        {
            let clipboard = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
            let result = match clipboard.wait_for_image() {
                Some(pixbuf) => {
                    pixbuf.save_to_bufferv("png", &[])
                        .map_err(|e| e.to_string())
                        .map(|bytes| {
                            use base64::Engine;
                            base64::engine::general_purpose::STANDARD.encode(&bytes)
                        })
                }
                None => Err("no image in clipboard".to_string()),
            };
            let _ = tx.send(result);
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = tx.send(Err("not implemented on this platform".to_string()));
        }
    })
    .map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string())?)
        .await
        .map_err(|e| e.to_string())?
}

/// Returns a sorted, deduplicated list of font family names available on the system.
#[tauri::command]
pub async fn list_system_fonts() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(collect_system_fonts)
        .await
        .unwrap_or_default()
}

/// Fetches a remote URL and returns (base64_data, mime_type).
/// Used by PDF/PPTX export to download remote images natively, bypassing the
/// webview CSP connect-src restrictions that block fetch() to arbitrary URLs.
#[tauri::command]
pub async fn fetch_url_b64(url: String) -> Result<(String, String), String> {
    use base64::Engine;
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("URL must use HTTP or HTTPS".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("client error: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("fetch failed: HTTP {}", resp.status()));
    }
    let raw_mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .split(';')
        .next()
        .unwrap_or("image/png")
        .trim()
        .to_lowercase();
    // Normalise non-standard JPEG variants so browsers accept the data URL.
    let mime = match raw_mime.as_str() {
        "image/jpg" | "image/pjpeg" | "image/x-jpeg" => "image/jpeg".to_string(),
        other => other.to_string(),
    };
    let bytes = resp.bytes().await.map_err(|e| format!("read failed: {e}"))?;
    Ok((base64::engine::general_purpose::STANDARD.encode(&bytes), mime))
}

/// Fetch a URL and return its body as UTF-8 text. Used for "Import from URL"
/// to bypass webview CSP connect-src restrictions.
#[tauri::command]
pub async fn fetch_url_text(url: String) -> Result<String, String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("URL must use HTTP or HTTPS".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("client error: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("fetch failed: HTTP {}", resp.status()));
    }

    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let ct_ok = ct.is_empty()
        || ct.starts_with("text/")
        || ct.starts_with("application/json")
        || ct.starts_with("application/xml")
        || ct.starts_with("application/xhtml");
    if !ct_ok {
        return Err(format!("unexpected Content-Type: {ct}"));
    }

    const MAX_TEXT_BYTES: u64 = 20 * 1024 * 1024; // 20 MB
    if resp.content_length().unwrap_or(0) > MAX_TEXT_BYTES {
        return Err("response too large (max 20 MB)".into());
    }

    let text = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
    if text.len() as u64 > MAX_TEXT_BYTES {
        return Err("response too large (max 20 MB)".into());
    }
    Ok(text)
}

fn collect_system_fonts() -> Vec<String> {
    #[cfg(target_os = "linux")]
    {
        let output = match std::process::Command::new("fc-list")
            .arg("--format")
            .arg("%{family[0]}\n")
            .output()
        {
            Ok(o) => o,
            Err(_) => return vec![],
        };
        sort_dedup_fonts(parse_line_output(&output.stdout))
    }

    #[cfg(target_os = "macos")]
    {
        // Prefer fc-list when Homebrew fontconfig is installed.
        let fc = std::process::Command::new("fc-list")
            .arg("--format")
            .arg("%{family[0]}\n")
            .output()
            .ok()
            .filter(|o| o.status.success() && !o.stdout.is_empty());

        if let Some(out) = fc {
            return sort_dedup_fonts(parse_line_output(&out.stdout));
        }

        // Fallback: system_profiler is always available on macOS.
        // Its output contains lines like:
        //   Family: Helvetica Neue
        // We extract the value after the "Family: " prefix.
        let output = match std::process::Command::new("system_profiler")
            .args(["SPFontsDataType"])
            .output()
        {
            Ok(o) => o,
            Err(_) => return vec![],
        };
        let text = String::from_utf8_lossy(&output.stdout);
        let families: Vec<String> = text
            .lines()
            .filter_map(|line| {
                let trimmed = line.trim();
                trimmed.strip_prefix("Family: ").map(|f| f.trim().to_string())
            })
            .filter(|s| !s.is_empty())
            .collect();
        sort_dedup_fonts(families)
    }

    #[cfg(target_os = "windows")]
    {
        // Windows: enumerate fonts via PowerShell (.NET InstalledFontCollection)
        let output = match std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[System.Drawing.Text.InstalledFontCollection]::new().Families | \
                 ForEach-Object { $_.Name }",
            ])
            .output()
        {
            Ok(o) => o,
            Err(_) => return vec![],
        };
        sort_dedup_fonts(parse_line_output(&output.stdout))
    }
}

fn parse_line_output(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

fn sort_dedup_fonts(mut fonts: Vec<String>) -> Vec<String> {
    fonts.sort_unstable_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    fonts.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
    fonts
}

// ── Native PDF export ────────────────────────────────────────────────────────

/// Render a self-contained HTML document to a PDF file using the platform's
/// Returns Ok if native PDF export is available on this platform; returns
/// Err("not yet implemented") on platforms where only the JS raster fallback
/// is used. Callers should check this before building the HTML document to
/// avoid sending a large payload over IPC unnecessarily.
#[tauri::command]
pub fn check_native_pdf() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return Err("not yet implemented".into());
    #[cfg(not(target_os = "linux"))]
    Ok(())
}

/// native WebView print API (WKWebView on macOS, WebView2 on Windows).
/// The HTML must be fully self-contained (all fonts and images embedded as
/// data: URIs) so the hidden render window needs no network or asset:// access.
#[tauri::command]
pub async fn export_pdf_native(
    app: AppHandle,
    html_content: String,
    output_path: String,
    width_mm: f64,
    height_mm: f64,
) -> Result<(), String> {
    use tauri::Manager;

    // Write HTML to a temp file so the hidden WebviewWindow can navigate to it.
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app cache dir: {e}"))?;
    std::fs::create_dir_all(&cache_dir).ok();

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let html_path = cache_dir.join(format!("kova-print-{ts}.html"));
    std::fs::write(&html_path, html_content.as_bytes())
        .map_err(|e| format!("write temp html: {e}"))?;

    let html_path_str = html_path.to_str().ok_or("html_path is non-UTF-8")?.to_string();

    // Linux: no native PDF backend — fall through to the raster path in JS.
    #[cfg(target_os = "linux")]
    {
        let _ = (width_mm, height_mm, html_path_str, output_path);
        let _ = std::fs::remove_file(&html_path);
        return Err("not yet implemented".into());
    }

    // macOS / Windows: load the HTML in a hidden WebviewWindow and use the
    // platform's native WebView printing API.
    #[cfg(not(target_os = "linux"))]
    {
        // Produce a valid file:// URL.
        // On Windows: C:\foo\bar.html → file:///C:/foo/bar.html (triple slash required)
        // On Unix:    /path/bar.html  → file:///path/bar.html
        let raw_path = html_path_str.replace('\\', "/");
        let file_url = if raw_path.starts_with('/') {
            format!("file://{raw_path}")
        } else {
            format!("file:///{raw_path}")
        };
        let url = file_url
            .parse::<tauri::Url>()
            .map_err(|e| format!("url parse: {e}"))?;

        let label = format!("kova-print-{ts}");

        // Create an invisible window for off-screen PDF rendering.
        // Register on_page_load on the builder so we know when the document is ready.
        let (load_tx, load_rx) = std::sync::mpsc::sync_channel::<()>(1);
        let load_tx2 = load_tx.clone();
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            &label,
            tauri::WebviewUrl::External(url),
        )
        .visible(false)
        .decorations(false)
        .inner_size(960.0, 540.0)
        .on_page_load(move |_win, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = load_tx2.send(());
            }
        })
        .build()
        .map_err(|e| format!("create print window: {e}"))?;
        drop(load_tx);

        tauri::async_runtime::spawn_blocking(move || {
            load_rx
                .recv_timeout(std::time::Duration::from_secs(30))
                .ok();
        })
        .await
        .ok();

        // Give fonts and lazy-rendered content a moment to settle.
        tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(std::time::Duration::from_millis(500));
        })
        .await
        .ok();

        #[cfg(target_os = "macos")]
        let result = platform_macos::generate_pdf(&window, &output_path).await;

        #[cfg(target_os = "windows")]
        let result =
            platform_windows::generate_pdf(&window, &output_path, width_mm, height_mm).await;

        let _ = window.destroy();
        let _ = std::fs::remove_file(&html_path);

        result
    }
}

// ── macOS: WKWebView.createPDFWithConfiguration:completionHandler: ────────────

#[cfg(target_os = "macos")]
mod platform_macos {
    use tauri::WebviewWindow;

    pub async fn generate_pdf(window: &WebviewWindow, output_path: &str) -> Result<(), String> {
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<Vec<u8>, String>>(1);
        let output = output_path.to_string();

        window
            .with_webview(move |wv| {
                use block2::RcBlock;
                use objc2::{msg_send, runtime::AnyObject};

                // wv.inner() is the raw WKWebView id pointer.
                let webview = wv.inner() as *mut AnyObject;

                // Allocate a WKPDFConfiguration with default settings.
                let config: *mut AnyObject = unsafe {
                    let cls = objc2::runtime::AnyClass::get(c"WKPDFConfiguration")
                        .expect("WKPDFConfiguration");
                    msg_send![cls, new]
                };

                let tx2 = tx.clone();
                let block =
                    RcBlock::new(move |data: *mut AnyObject, error: *mut AnyObject| {
                        if !error.is_null() || data.is_null() {
                            let _ = tx2.send(Err("WKWebView PDF creation failed".into()));
                            return;
                        }
                        let bytes: Vec<u8> = unsafe {
                            let len: usize = msg_send![data, length];
                            let ptr: *const u8 = msg_send![data, bytes];
                            std::slice::from_raw_parts(ptr, len).to_vec()
                        };
                        let _ = tx2.send(Ok(bytes));
                    });

                unsafe {
                    let _: () = msg_send![
                        webview,
                        createPDFWithConfiguration: config
                        completionHandler: &*block
                    ];
                    // config was +1 from `new`; balance it now that the call has retained it.
                    let _: () = msg_send![config, release];
                }
            })
            .map_err(|e| format!("with_webview: {e}"))?;

        let bytes = tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(std::time::Duration::from_secs(60))
                .map_err(|_| "PDF generation timed out".to_string())
                .and_then(|r| r)
        })
        .await
        .map_err(|e| format!("{e}"))??;

        std::fs::write(&output, &bytes).map_err(|e| format!("write PDF: {e}"))
    }
}

// ── Windows: WebView2 ICoreWebView2_7::PrintToPdf ────────────────────────────

#[cfg(target_os = "windows")]
mod platform_windows {
    use tauri::WebviewWindow;

    pub async fn generate_pdf(
        window: &WebviewWindow,
        output_path: &str,
        width_mm: f64,
        height_mm: f64,
    ) -> Result<(), String> {
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
        let output = output_path.to_string();

        window
            .with_webview(move |wv| {
                use webview2_com::{
                    Microsoft::Web::WebView2::Win32::{ICoreWebView2_7, ICoreWebView2Environment6},
                    PrintToPdfCompletedHandler,
                };
                use windows::core::{Interface, PCWSTR};

                // ICoreWebView2Controller → ICoreWebView2 → ICoreWebView2_7
                let controller = wv.controller();
                let webview = match unsafe { controller.CoreWebView2() } {
                    Ok(wv) => wv,
                    Err(e) => {
                        let _ = tx.send(Err(format!("CoreWebView2(): {e}")));
                        return;
                    }
                };
                let webview7 = match webview.cast::<ICoreWebView2_7>() {
                    Ok(wv7) => wv7,
                    Err(e) => {
                        let _ = tx.send(Err(format!("cast to ICoreWebView2_7: {e}")));
                        return;
                    }
                };

                // Build PrintSettings with the slide's exact page dimensions and no
                // margins. PageWidth/PageHeight are in inches (1 in = 25.4 mm). Falls
                // back to None on older WebView2 runtimes so the call still succeeds.
                let print_settings = wv
                    .environment()
                    .cast::<ICoreWebView2Environment6>()
                    .ok()
                    .and_then(|env6| unsafe { env6.CreatePrintSettings() }.ok())
                    .and_then(|s| unsafe {
                        let _ = s.SetPageWidth(width_mm / 25.4);
                        let _ = s.SetPageHeight(height_mm / 25.4);
                        let _ = s.SetMarginTop(0.0);
                        let _ = s.SetMarginBottom(0.0);
                        let _ = s.SetMarginLeft(0.0);
                        let _ = s.SetMarginRight(0.0);
                        Some(s)
                    });

                // Encode file path as NUL-terminated UTF-16.
                let path_wide: Vec<u16> =
                    output.encode_utf16().chain(std::iter::once(0)).collect();

                let tx_handler = tx.clone();
                let handler =
                    PrintToPdfCompletedHandler::create(Box::new(move |err, is_successful| {
                        if let Err(e) = err {
                            let _ = tx_handler.send(Err(format!("PrintToPdf error: {e}")));
                        } else if !is_successful {
                            let _ = tx_handler.send(Err(
                                "PrintToPdf completed but reported failure".into(),
                            ));
                        } else {
                            let _ = tx_handler.send(Ok(()));
                        }
                        Ok(())
                    }));

                // PrintToPdf copies the path string synchronously, so path_wide
                // only needs to live until this call returns.
                if let Err(e) = unsafe {
                    webview7.PrintToPdf(
                        PCWSTR(path_wide.as_ptr()),
                        print_settings.as_ref(),
                        &handler,
                    )
                } {
                    let _ = tx.send(Err(format!("PrintToPdf call failed: {e}")));
                }
                drop(path_wide);
            })
            .map_err(|e| format!("with_webview: {e}"))?;

        tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(std::time::Duration::from_secs(60))
                .map_err(|_| "PrintToPdf timed out".to_string())
                .and_then(|r| r)
        })
        .await
        .map_err(|e| format!("{e}"))?
    }
}

// ── Linux: no native PDF backend ──────────────────────────────────────────────
//
// The export_pdf_native command returns "not yet implemented" on Linux so
// App.tsx falls back to the PNG raster path via jsPDF.
