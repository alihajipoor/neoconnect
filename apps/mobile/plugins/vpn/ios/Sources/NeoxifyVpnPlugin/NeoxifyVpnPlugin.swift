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

    @objc public func disconnect(_ invoke: Invoke) {
        Task {
            let managers = (try? await NETunnelProviderManager.loadAllFromPreferences()) ?? []
            for manager in managers { manager.connection.stopVPNTunnel() }
            invoke.resolve()
        }
    }

    @objc public func status(_ invoke: Invoke) {
        Task {
            let managers = (try? await NETunnelProviderManager.loadAllFromPreferences()) ?? []
            let state = managers.first?.connection.status ?? .invalid
            invoke.resolve(["connected": state == .connected, "state": String(describing: state)])
        }
    }
}

@_cdecl("init_plugin_neoxify_vpn")
func initPlugin() -> Plugin { NeoxifyVpnPlugin() }
