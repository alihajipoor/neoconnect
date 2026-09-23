// swift-tools-version:5.9
import PackageDescription

let package = Package(
    // Named for the CRATE, not the plugin. Tauri links the Swift package
    // as a native static library using the Rust crate name, so a product
    // called anything else fails at link with "could not find native
    // static library `tauri-plugin-neoxify-vpn`".
    name: "tauri-plugin-neoxify-vpn",
    // 15.0 to match the app and the extension. A plugin package that
    // allows an older floor than the target embedding it fails to
    // resolve rather than warning.
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "tauri-plugin-neoxify-vpn", type: .static, targets: ["NeoxifyVpnPlugin"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
    ],
    targets: [
        .target(
            name: "NeoxifyVpnPlugin",
            dependencies: [.byName(name: "Tauri")],
            path: "Sources/NeoxifyVpnPlugin",
        ),
    ],
)
