// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "neoxify-vpn",
    // 15.0 to match the app and the extension. A plugin package that
    // allows an older floor than the target embedding it fails to
    // resolve rather than warning.
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "neoxify-vpn", type: .static, targets: ["NeoxifyVpnPlugin"]),
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
