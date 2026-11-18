import Foundation
import Network
import Tauri

/// What the phone and the network under the tunnel are, for a connect
/// report (docs/client-diagnostics.md, `details.device` and `details.net`),
/// answered by the plugin's `deviceFacts`.
///
/// In a file of its own because it imports Network, and NetworkExtension
/// -- which the plugin file needs -- declares an older class of the same
/// name as Network's `NWPath`. Apart, neither file has to qualify it.
///
/// Every fact is left out when it cannot be read; nothing here throws.
/// Not reported, because iOS gives an app no public way to read them: the
/// system's DNS servers, Private DNS (iOS has no such setting), free
/// memory for the whole device, and whether another app's VPN is up.
/// Nothing here names a place the customer went.
enum DeviceFacts {
    /// How long one network reading may take. Two are taken, and the Rust
    /// side gives up on the whole answer after one second.
    private static let pathWait: TimeInterval = 0.35

    static func read() async -> JsonObject {
        var facts: JsonObject = ["os": "iOS"]
        if let model = model() { facts["model"] = model }
        facts["osVersion"] = osVersion()
        facts["lowPower"] = ProcessInfo.processInfo.isLowPowerModeEnabled
        if let net = await network() {
            if let constrained = net.constrained { facts["dataSaver"] = constrained }
            if !net.fields.isEmpty { facts["net"] = net.fields }
        }
        return facts
    }

    /// The hardware identifier, e.g. "iPhone16,2". Never the device's
    /// name, which is the customer's own words ("Sara's iPhone").
    static func model() -> String? {
        var info = utsname()
        guard uname(&info) == 0 else { return nil }
        let name = withUnsafeBytes(of: &info.machine) { raw -> String in
            String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// "18.1", or "18.1.1" when there is a patch number.
    static func osVersion() -> String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return v.patchVersion > 0
            ? "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
            : "\(v.majorVersion).\(v.minorVersion)"
    }

    /// The network under the tunnel.
    ///
    /// A plain path monitor describes the path traffic takes, which while
    /// a tunnel is up is the tunnel. So its reading is used only to learn
    /// which physical interface is under it -- the first of its interfaces
    /// that is Wi-Fi, cellular or wired, the tunnel's own being "other" --
    /// and a second monitor pinned to that interface type reads that
    /// network's own address families and cost.
    private static func network() async -> (fields: [String: Any], constrained: Bool?)? {
        guard let general = await snapshot(NWPathMonitor()) else { return nil }
        var fields: [String: Any] = [:]
        let physical = general.availableInterfaces.first { iface in
            iface.type == .wifi || iface.type == .cellular || iface.type == .wiredEthernet
        }
        guard let under = physical else {
            // Read, and nothing physical is there: no network at all when
            // the path is down too; something we cannot name otherwise.
            fields["type"] = general.status == .unsatisfied ? "none" : "other"
            return (fields, nil)
        }
        switch under.type {
        case .wifi: fields["type"] = "wifi"
        case .cellular: fields["type"] = "cellular"
        case .wiredEthernet: fields["type"] = "ethernet"
        default: fields["type"] = "other"
        }
        guard let pinned = await snapshot(NWPathMonitor(requiredInterfaceType: under.type)),
              pinned.status == .satisfied else {
            return (fields, nil)
        }
        fields["metered"] = pinned.isExpensive
        fields["ipv4"] = pinned.supportsIPv4
        fields["ipv6"] = pinned.supportsIPv6
        let constrained: Bool? = pinned.isConstrained
        return (fields, constrained)
    }

    /// The monitor's first reading, or nil when none came in time. The
    /// monitor is cancelled either way.
    private static func snapshot(_ monitor: NWPathMonitor) async -> NWPath? {
        await withCheckedContinuation { continuation in
            let once = ProviderTotals.Once()
            let queue = DispatchQueue(label: "com.neoxify.vpn.facts")
            let finish: (NWPath?) -> Void = { path in
                once.run {
                    monitor.cancel()
                    continuation.resume(returning: path)
                }
            }
            monitor.pathUpdateHandler = { path in finish(path) }
            monitor.start(queue: queue)
            queue.asyncAfter(deadline: .now() + pathWait) { finish(nil) }
        }
    }
}
