fn main() {
    // Icons are read by the bundler, but only tauri.conf.json is registered
    // as a rerun trigger; the Windows app shipped a stale icon that way.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
