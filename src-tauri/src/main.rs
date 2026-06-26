// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
#[link(name = "X11")]
extern "C" {
    fn XInitThreads() -> std::ffi::c_int;
}

#[cfg(target_os = "linux")]
extern "C" {
    fn dlopen(
        filename: *const std::os::raw::c_char,
        flag: std::os::raw::c_int,
    ) -> *mut std::os::raw::c_void;
    fn dlsym(
        handle: *mut std::os::raw::c_void,
        symbol: *const std::os::raw::c_char,
    ) -> *mut std::os::raw::c_void;
    fn dlclose(handle: *mut std::os::raw::c_void) -> std::os::raw::c_int;
}

// Probes whether EGL can actually open a Wayland platform display.
// Used on native (non-AppImage) Wayland installs to detect broken EGL stacks
// (e.g. VM GPU drivers) and fall back to Mesa llvmpipe before WebKit starts.
//
// Note: this probe is not applied to AppImage builds. The AppImage bundles
// WebKitGTK compiled on Ubuntu 22.04 whose WebProcess crashes on non-Ubuntu
// EGL stacks regardless of env vars — the bubblewrap sandbox filters out
// LIBGL_ALWAYS_SOFTWARE before it reaches the subprocess. A proper fix is
// in progress upstream: https://github.com/tauri-apps/tauri/pull/12491
#[cfg(target_os = "linux")]
fn egl_wayland_display_works() -> bool {
    use std::ffi::{CStr, CString};
    use std::os::raw::{c_char, c_void};

    type WlDisplayConnectFn = unsafe extern "C" fn(*const c_char) -> *mut c_void;
    type WlDisplayDisconnectFn = unsafe extern "C" fn(*mut c_void);
    type EglGetPlatformDisplayFn = unsafe extern "C" fn(u32, *mut c_void, *const usize) -> *mut c_void;
    type EglQueryStringFn = unsafe extern "C" fn(*mut c_void, i32) -> *const c_char;

    macro_rules! load_sym {
        ($handle:expr, $name:literal) => {{
            let s = CString::new($name).unwrap();
            dlsym($handle, s.as_ptr())
        }};
    }

    let wl_lib = match CString::new("libwayland-client.so.0") {
        Ok(s) => s,
        Err(_) => return true,
    };
    let egl_lib = match CString::new("libEGL.so.1") {
        Ok(s) => s,
        Err(_) => return true,
    };

    unsafe {
        let wl_handle = dlopen(wl_lib.as_ptr(), 1 /* RTLD_LAZY */);
        if wl_handle.is_null() {
            return true;
        }

        let egl_handle = dlopen(egl_lib.as_ptr(), 1 /* RTLD_LAZY */);
        if egl_handle.is_null() {
            dlclose(wl_handle);
            return true;
        }

        let wl_connect_ptr = load_sym!(wl_handle, "wl_display_connect");
        let wl_disconnect_ptr = load_sym!(wl_handle, "wl_display_disconnect");
        let egl_get_platform_ptr = load_sym!(egl_handle, "eglGetPlatformDisplayEXT");
        let egl_query_ptr = load_sym!(egl_handle, "eglQueryString");

        if egl_get_platform_ptr.is_null() || wl_connect_ptr.is_null() {
            dlclose(egl_handle);
            dlclose(wl_handle);
            return true;
        }

        if !egl_query_ptr.is_null() {
            let query: EglQueryStringFn = std::mem::transmute(egl_query_ptr);
            let ext_ptr = query(std::ptr::null_mut(), 0x3055 /* EGL_EXTENSIONS */);
            if ext_ptr.is_null() {
                dlclose(egl_handle);
                dlclose(wl_handle);
                return false;
            }
            let exts = CStr::from_ptr(ext_ptr).to_string_lossy();
            if !exts.contains("EGL_EXT_platform_wayland")
                && !exts.contains("EGL_KHR_platform_wayland")
            {
                dlclose(egl_handle);
                dlclose(wl_handle);
                return false;
            }
        }

        let wl_connect: WlDisplayConnectFn = std::mem::transmute(wl_connect_ptr);
        let wl_display = wl_connect(std::ptr::null());

        if wl_display.is_null() {
            dlclose(egl_handle);
            dlclose(wl_handle);
            return true;
        }

        let egl_get_platform: EglGetPlatformDisplayFn =
            std::mem::transmute(egl_get_platform_ptr);
        // EGL_PLATFORM_WAYLAND_EXT = 0x31D8
        let egl_display = egl_get_platform(0x31D8, wl_display, std::ptr::null());

        let wl_disconnect: WlDisplayDisconnectFn = std::mem::transmute(wl_disconnect_ptr);
        wl_disconnect(wl_display);

        dlclose(egl_handle);
        dlclose(wl_handle);

        !egl_display.is_null()
    }
}

fn main() {
    // Must be called before any X11 calls are made from any thread.
    // Without this, opening a second window (presentation mode) triggers an
    // XCB multi-thread assertion crash on X11 sessions.
    #[cfg(target_os = "linux")]
    unsafe {
        XInitThreads();
    }

    // WebKitGTK 2.42+ enables the DMA-BUF renderer by default, which fails
    // with EGL_BAD_DISPLAY on some wlroots-based Wayland compositors (Arch,
    // CachyOS). Must be set before the webview is created.
    #[cfg(target_os = "linux")]
    if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    // On native (non-AppImage) Wayland sessions, probe whether the host EGL
    // stack can create a Wayland platform display. If not (broken VM GPU
    // drivers, etc.), fall back to Mesa llvmpipe before WebKit launches.
    // AppImage builds are excluded: the bubblewrap sandbox filters
    // LIBGL_ALWAYS_SOFTWARE before it reaches the WebKitWebProcess subprocess,
    // so it has no effect. The AppImage EGL portability issue is tracked at
    // https://github.com/tauri-apps/tauri/pull/12491 (Tauri 2.12).
    #[cfg(target_os = "linux")]
    if std::env::var("APPIMAGE").is_err()
        && std::env::var("WAYLAND_DISPLAY").is_ok()
        && std::env::var("LIBGL_ALWAYS_SOFTWARE").is_err()
        && !egl_wayland_display_works()
    {
        std::env::set_var("LIBGL_ALWAYS_SOFTWARE", "1");
    }

    kova_lib::run()
}
