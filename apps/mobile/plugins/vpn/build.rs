// No plugin commands: the tunnel commands are registered on the app
// instead (see the app's lib.rs), which is what lets them skip capability
// entries. This plugin exists purely to get its `android/` project into
// the Gradle build and to hand the app a handle to the Kotlin side.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
