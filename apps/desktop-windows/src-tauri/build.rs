fn main() {
    // tauri_build::build() compiles icons/icon.ico into the Windows
    // executable's resources, but only registers tauri.conf.json as a
    // rerun trigger. Changing an icon without also touching that config
    // leaves the previously generated resource.lib in place, and the old
    // icon stays silently linked into the binary -- which is how a build
    // shipped with Tauri's stock placeholder icon after the real one was
    // already on disk. `cargo clean -p` did not clear it either, so this
    // is the only reliable guard.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
