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

    // WebKitGTK C API — linked transitively through the webkit2gtk dep.
    fn webkit_web_context_get_default() -> *mut std::os::raw::c_void;
    fn webkit_web_context_set_sandbox_enabled(
        context: *mut std::os::raw::c_void,
        enabled: std::os::raw::c_int,
    );
}

// Probes whether EGL can actually create a Wayland platform display.
//
// The AppImage bundles WebKitGTK built on Ubuntu 22.04, which calls
// eglGetPlatformDisplayEXT(EGL_PLATFORM_WAYLAND_EXT, wl_display, NULL) against
// whatever libEGL.so.1 is on the host system. On Fedora 44 with Mesa 26.x and
// virtual GPU drivers (virgl, vmwgfx), Mesa advertises EGL_EXT_platform_wayland
// in the extension string but the actual display creation fails with
// EGL_BAD_PARAMETER, aborting the WebKit web process before the window appears.
//
// We replicate the exact call WebKit makes — connecting to the Wayland compositor
// ourselves and attempting eglGetPlatformDisplayEXT — so we detect real failures
// rather than just checking whether the extension string mentions the platform.
// If it fails, LIBGL_ALWAYS_SOFTWARE=1 forces Mesa llvmpipe, whose EGL reliably
// supports the Wayland platform on all compositors.
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
            return true; // Can't load Wayland — not our problem
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

        // Without the platform display function we can't replicate WebKit's call
        if egl_get_platform_ptr.is_null() || wl_connect_ptr.is_null() {
            dlclose(egl_handle);
            dlclose(wl_handle);
            return true;
        }

        // Fast path: if EGL_EXT_platform_wayland isn't even in the client
        // extension string the display creation will definitely fail.
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

        // Extension is advertised — now actually attempt the call WebKit makes.
        // Our Wayland connection is independent of GTK's; connecting a second
        // client to the same compositor is safe and normal.
        let wl_connect: WlDisplayConnectFn = std::mem::transmute(wl_connect_ptr);
        let wl_display = wl_connect(std::ptr::null()); // NULL → use WAYLAND_DISPLAY

        if wl_display.is_null() {
            // Can't reach the compositor at all — not an EGL issue
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
    // XCB multi-thread assertion crash on X11 sessions (Ubuntu 22.04, etc.).
    #[cfg(target_os = "linux")]
    unsafe {
        XInitThreads();
    }

    // WebKitGTK 2.42+ enables the DMA-BUF renderer by default, which fails
    // with EGL_BAD_DISPLAY on some AMD GPU configurations (Arch-based distros
    // like CachyOS). Must be set before the webview is created.
    // Respect any explicit override the user has already set.
    #[cfg(target_os = "linux")]
    if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    #[cfg(target_os = "linux")]
    if std::env::var("APPIMAGE").is_ok() {
        // The AppImage bundles WebKitGTK compiled on Ubuntu 22.04. Its
        // Wayland EGL path (eglGetPlatformDisplayEXT EGL_PLATFORM_WAYLAND_EXT)
        // fails with EGL_BAD_PARAMETER on non-Ubuntu EGL stacks (Fedora Mesa
        // 26.x, virgl/vmwgfx VMs, etc.), aborting the WebProcess.
        //
        // Two env vars together fix it when XWayland is available:
        // - GDK_BACKEND=x11  → GTK uses the X11 display backend
        // - unset WAYLAND_DISPLAY → WebKit's internal platform detection also
        //   falls back to X11 EGL instead of Wayland EGL (WebKit checks this
        //   independently of GDK, so GDK_BACKEND alone is not enough)
        //
        // Guard on DISPLAY so we don't break pure-Wayland setups without XWayland.
        if std::env::var("DISPLAY").is_ok() {
            if std::env::var("GDK_BACKEND").is_err() {
                std::env::set_var("GDK_BACKEND", "x11");
            }
            // Only unset if we're actually switching to X11; leave it alone
            // if the user has forced GDK_BACKEND to something else themselves.
            if std::env::var("GDK_BACKEND").ok().as_deref() == Some("x11") {
                std::env::remove_var("WAYLAND_DISPLAY");
            }
        }

        // WebKitGTK's bubblewrap sandbox cannot resolve paths correctly when
        // the parent process runs from an AppImage mount point.
        let _ = gtk::init();
        unsafe {
            let ctx = webkit_web_context_get_default();
            if !ctx.is_null() {
                webkit_web_context_set_sandbox_enabled(ctx, 0);
            }
        }
    } else {
        // Native install: if the host EGL can't create a Wayland platform
        // display (VM with broken GPU drivers, etc.) fall back to llvmpipe.
        #[cfg(target_os = "linux")]
        if std::env::var("WAYLAND_DISPLAY").is_ok()
            && std::env::var("LIBGL_ALWAYS_SOFTWARE").is_err()
            && !egl_wayland_display_works()
        {
            std::env::set_var("LIBGL_ALWAYS_SOFTWARE", "1");
        }
    }

    kova_lib::run()
}
