fn main() {
    // PDFKit is used to merge per-page captures into one multipage PDF (macOS export).
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-lib=framework=PDFKit");
    }
    tauri_build::build()
}
