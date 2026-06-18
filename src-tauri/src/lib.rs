mod commands;
mod file_io;
mod watcher;

use commands::{AppState, WatchState};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                // Just size/position/maximized — explicitly not VISIBLE, DECORATIONS,
                // or FULLSCREEN (all included in the crate's ::all() default): this is
                // a single-window editor with no hide-to-tray feature, so there's no
                // legitimate saved-as-hidden state to restore, and re-opening into OS
                // fullscreen unprompted would be a surprise users didn't ask for.
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                // The audience (presentation output) window is positioned
                // programmatically onto an external monitor by setup_audience_window
                // every time a presentation starts — it must never be restored from a
                // stale saved position/size, which would fight that placement logic.
                .with_denylist(&["audience"])
                .build(),
        )
        .manage(AppState {
            watch: Mutex::new(WatchState { current_file: None, watcher: None }),
            exit_confirmed: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::start_watching,
            commands::rename_file,
            commands::stop_watching,
            commands::load_keybindings,
            commands::load_custom_themes,
            commands::list_system_fonts,
            commands::write_file_bytes,
            commands::read_file_b64,
            commands::write_asset_bytes,
            commands::copy_image_to_assets,
            commands::scan_asset_refs,
            commands::copy_file_with_assets,
            commands::show_in_file_manager,
            commands::setup_audience_window,
            commands::debug_monitors,
            commands::can_self_update,
            commands::restart_app,
            commands::save_theme,
            commands::delete_theme,
            commands::download_and_cache_font,
            commands::set_wake_lock,
            commands::read_clipboard_image,
            commands::fetch_url_b64,
            commands::confirm_exit,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Cmd+Q (macOS default app menu), Dock "Quit", and any other app-level quit
    // triggers RunEvent::ExitRequested rather than the main window's
    // CloseRequested — the latter is already guarded by the frontend's
    // `onCloseRequested` listener (App.tsx), but that listener never fires for
    // an app-level quit. Intercept here so unsaved changes get the same
    // confirmation prompt regardless of which gesture the user used to quit.
    app.run(move |app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let state = app_handle.state::<AppState>();
            if state.exit_confirmed.load(Ordering::SeqCst) {
                return; // user already confirmed via confirm_exit — let it through
            }
            // Only intercept while the main window is still alive; if it has
            // already closed cleanly (e.g. via the window-level close flow) there
            // is nothing left to confirm and the exit should proceed normally.
            if app_handle.get_webview_window("main").is_some() {
                api.prevent_exit();
                let _ = app_handle.emit("app-exit-requested", ());
            }
        }
    });
}
