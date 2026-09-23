import NetworkExtension
import Tauri
import UIKit

/// The app half of the VPN, mirroring the Kotlin plugin on Android.
///
/// It does not carry packets. On iOS it cannot: the app process may only
/// ask the system to start a provider, which runs as a separate
/// extension. So everything here is about the profile -- installing it,
/// starting it, reporting on it -- and the tunnel itself lives in
/// PacketTunnelProvider.
///
/// The asymmetry with Android is worth stating, because the JS side sees
/// one API. There, permission is an Activity result and the tunnel is a
/// Service in the same process. Here, permission is the user allowing a
/// VPN configuration to be saved, and there is no equivalent of
/// listing installed apps -- per-app routing is the system's on iOS,
/// not ours.
class NeoxifyVpnPlugin: Plugin {
    /// The provider bundle identifier, which must match the extension's.
    /// A mismatch is accepted when the profile is saved and fails only
    /// when the tunnel is started, with a message that does not say so.
    private let providerBundleIdentifier = "com.neoxify.mobile.tunnel"

    private func loadManager() async throws -> NETunnelProviderManager {
        let existing = try await NETunnelProviderManager.loadAllFromPreferences()
        return existing.first ?? NETunnelProviderManager()
    }

    @objc public func hasPermission(_ invoke: Invoke) {
        Task {
            do {
                // A saved profile is the only evidence the user agreed.
                // There is no permission to query on iOS: the system
                // asks when a configuration is first saved, and a saved
                // one means they said yes.
                let managers = try await NETunnelProviderManager.loadAllFromPreferences()
                invoke.resolve(["granted": !managers.isEmpty])
            } catch {
                invoke.reject("could not read the VPN configuration: \(error.localizedDescription)")
            }
        }
    }

    @objc public func requestPermission(_ invoke: Invoke) {
        Task {
            do {
                let manager = try await loadManager()
                let proto = NETunnelProviderProtocol()
                proto.providerBundleIdentifier = providerBundleIdentifier
                // Required, and required to be non-empty, even though the
                // real address comes from the config passed at connect.
                proto.serverAddress = "Neoxify"
                manager.protocolConfiguration = proto
                manager.localizedDescription = "Neoxify"
                manager.isEnabled = true
                // Saving is what triggers the system prompt. Until this
                // returns, the user has not been asked.
                try await manager.saveToPreferences()
                invoke.resolve(["granted": true])
            } catch {
                // A refusal arrives as an error, so it is not
                // distinguishable here from a genuine failure -- report
                // it as not granted rather than as broken.
                invoke.resolve(["granted": false])
            }
        }
    }

    @objc public func connectXray(_ invoke: Invoke) {
        struct Args: Decodable { let config: String }
        Task {
            do {
                let args = try invoke.parseArgs(Args.self)
                let manager = try await loadManager()
                let proto = (manager.protocolConfiguration as? NETunnelProviderProtocol) ?? NETunnelProviderProtocol()
                proto.providerBundleIdentifier = providerBundleIdentifier
                proto.serverAddress = "Neoxify"
                // Carried in the profile rather than only in the start
                // options, so a tunnel the system restarts on its own --
                // on demand, or after a crash -- still has its config.
                proto.providerConfiguration = ["config": args.config]
                manager.protocolConfiguration = proto
                manager.isEnabled = true
                try await manager.saveToPreferences()
                // Reloaded before starting: saveToPreferences invalidates
                // the in-memory object, and starting the stale one fails
                // with a permission error that has nothing to do with
                // permissions.
                try await manager.loadFromPreferences()
                try manager.connection.startVPNTunnel(options: ["config": args.config as NSString])
                invoke.resolve()
            } catch {
                invoke.reject("could not start the tunnel: \(error.localizedDescription)")
            }
        }
    }

    /// WireGuard, which goes through the same extension as Xray.
    ///
    /// iOS allows a packet-tunnel extension exactly one principal class,
    /// so this does not start a second provider -- it starts the same one
    /// with a different payload, and the provider picks the engine. The
    /// profile is re-encoded rather than forwarded verbatim because
    /// providerConfiguration takes property-list values, and the
    /// extension wants one string it can decode.
    // `connectWireguard`, lower-case g, because that is the name the
    // Rust command invokes and the name the Kotlin plugin registers.
    // Spelling it the way the product does compiles fine on both sides
    // and fails only at runtime, with "method not found".
    @objc public func connectWireguard(_ invoke: Invoke) {
        struct Args: Codable {
            let privateKey: String
            let address: String
            let dns: String
            let serverPublicKey: String
            let endpoint: String
            let allowedIPs: String
        }
        Task {
            do {
                let args = try invoke.parseArgs(Args.self)
                guard let json = String(data: try JSONEncoder().encode(args), encoding: .utf8) else {
                    invoke.reject("the WireGuard profile could not be encoded")
                    return
                }
                let manager = try await loadManager()
                let proto = (manager.protocolConfiguration as? NETunnelProviderProtocol) ?? NETunnelProviderProtocol()
                proto.providerBundleIdentifier = providerBundleIdentifier
                proto.serverAddress = "Neoxify"
                // Only the WireGuard key, and the Xray one cleared. Both
                // present would leave the extension to guess, and a
                // stale Xray config from the previous connection is
                // exactly what it would find.
                proto.providerConfiguration = ["wireguard": json]
                manager.protocolConfiguration = proto
                manager.isEnabled = true
                try await manager.saveToPreferences()
                try await manager.loadFromPreferences()
                try manager.connection.startVPNTunnel(options: ["wireguard": json as NSString])
                invoke.resolve()
            } catch {
                invoke.reject("could not start WireGuard: \(error.localizedDescription)")
            }
        }
    }

    /// IKEv2, which does not go through the extension at all.
    ///
    /// Unlike connectXray there is no provider bundle, no config JSON
    /// and no Xray engine: the system's own IKEv2 client dials it. That
    /// makes it the one protocol here free of the extension's ~50MB
    /// memory ceiling, which is why it is worth having as a fallback
    /// even though it is the most easily blocked of the three.
    @objc public func connectIkev2(_ invoke: Invoke) {
        struct Args: Decodable {
            let server: String
            let username: String
            let password: String
        }
        Task {
            do {
                let args = try invoke.parseArgs(Args.self)
                try await Ikev2Engine.connect(
                    server: args.server, username: args.username, password: args.password)
                invoke.resolve()
            } catch {
                invoke.reject("could not start IKEv2: \(error.localizedDescription)")
            }
        }
    }

    @objc public func disconnect(_ invoke: Invoke) {
        Task {
            // Both stores, not just the tunnel providers. IKEv2 lives in
            // the single personal-VPN slot, which
            // `NETunnelProviderManager.loadAllFromPreferences` does not
            // return -- stopping only those would leave an IKEv2 tunnel
            // up while the app reported it down.
            let managers = (try? await NETunnelProviderManager.loadAllFromPreferences()) ?? []
            for manager in managers { manager.connection.stopVPNTunnel() }
            await Ikev2Engine.disconnect()
            invoke.resolve()
        }
    }

    @objc public func status(_ invoke: Invoke) {
        Task {
            let managers = (try? await NETunnelProviderManager.loadAllFromPreferences()) ?? []
            let tunnel = managers.first?.connection.status ?? .invalid
            let ikev2 = await Ikev2Engine.status()
            // Whichever is actually up. Only one can be at a time, so
            // preferring the connected one cannot mask the other; taking
            // the tunnel-provider state unconditionally would report a
            // live IKEv2 session as disconnected.
            let state = tunnel == .connected ? tunnel : (ikev2 == .connected ? ikev2 : tunnel)
            invoke.resolve(["connected": state == .connected, "state": String(describing: state)])
        }
    }
}

@_cdecl("init_plugin_neoxify_vpn")
func initPlugin() -> Plugin { NeoxifyVpnPlugin() }
