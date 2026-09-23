import NetworkExtension
import NeoxifyXray
import os

/// The iOS packet tunnel, running the same xray-core the nodes run.
///
/// The engine is shared with Android byte for byte -- one Go package,
/// built by gomobile for whichever platform asked. What differs is only
/// how each side obtains a tun device: Android opens one through
/// VpnService and passes the descriptor down; here the system opens it
/// for us and does not say which it is, so `TunDescriptor` finds it.
///
/// Both then take the identical supported path into xray-core, whose
/// darwin tun inbound accepts a descriptor from `xray.tun.fd` for
/// exactly this case.
final class PacketTunnelProvider: NEPacketTunnelProvider {
    private let log = Logger(subsystem: "com.neoxify.mobile", category: "tunnel")

    /// Addresses inside the tunnel.
    ///
    /// The peer address is the tunnel's own, not a real host: iOS wants a
    /// remote for the settings object, nothing routes to it, and using a
    /// real one would be a lie that shows up in a support log one day.
    private enum Tunnel {
        static let address = "198.18.0.1"
        static let netmask = "255.255.255.0"
        static let mtu = 1500
        /// 198.18.0.0/15 is the benchmarking range, chosen for the same
        /// reason the Windows client uses it: routable-looking, allocated
        /// to nobody, so it cannot collide with a customer's own network
        /// the way 10/8 or 192.168/16 routinely do.
        static let peer = "198.18.0.2"
    }

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        guard let configJSON = configuration(from: options) else {
            log.error("no xray configuration was passed to the tunnel")
            completionHandler(TunnelError.missingConfiguration)
            return
        }

        let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: Tunnel.peer)
        let ipv4 = NEIPv4Settings(addresses: [Tunnel.address], subnetMasks: [Tunnel.netmask])
        // Everything, because this is a full tunnel. Split tunnelling on
        // iOS is per-app and belongs to the system, not to us: there is no
        // equivalent of the Windows client's per-app redirect here.
        ipv4.includedRoutes = [NEIPv4Route.default()]
        settings.ipv4Settings = ipv4
        settings.mtu = NSNumber(value: Tunnel.mtu)

        // Resolvers inside the tunnel, matching every other client: the
        // lookup has to travel the tunnel or the name leaks to whatever
        // network the device is on, which is the failure that was
        // reported from Iran as "the IP changes but the site will not
        // open".
        let dns = NEDNSSettings(servers: ["1.1.1.1", "1.0.0.1"])
        dns.matchDomains = [""]
        settings.dnsSettings = dns

        setTunnelNetworkSettings(settings) { [weak self] error in
            guard let self else { return }
            if let error {
                self.log.error("the system refused the tunnel settings: \(error.localizedDescription)")
                completionHandler(error)
                return
            }
            self.startEngine(configJSON: configJSON, completionHandler: completionHandler)
        }
    }

    /// Hands the descriptor to xray-core.
    ///
    /// Only after `setTunnelNetworkSettings` has returned: the descriptor
    /// does not exist before the system has accepted the settings, so
    /// looking for it earlier finds nothing and the failure reads as a
    /// missing interface rather than a sequencing mistake.
    private func startEngine(configJSON: String, completionHandler: @escaping (Error?) -> Void) {
        guard let fd = TunDescriptor.current() else {
            log.error("the tunnel is up but its descriptor could not be found")
            completionHandler(TunnelError.noTunnelDescriptor)
            return
        }

        var engineError: NSError?
        let started = NeoxifyxrayStart(configJSON, Int(fd), NoopProtector(), &engineError)
        if !started {
            let message = engineError?.localizedDescription ?? "unknown"
            log.error("xray-core did not start: \(message)")
            completionHandler(engineError ?? TunnelError.engineFailed)
            return
        }

        log.info("tunnel up on descriptor \(fd)")
        completionHandler(nil)
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        log.info("stopping: \(String(describing: reason))")
        var error: NSError?
        // Reported, not propagated: stopTunnel has nowhere to return a
        // failure, and the system is tearing this process down either way.
        if !NeoxifyxrayStop(&error), let error {
            log.error("xray-core did not stop cleanly: \(error.localizedDescription)")
        }
        completionHandler()
    }

    private func configuration(from options: [String: NSObject]?) -> String? {
        if let passed = options?["config"] as? String, !passed.isEmpty { return passed }
        // The app stores it in the provider configuration when the
        // profile is saved, which is the path a tunnel started by the
        // system -- on demand, or from Settings -- comes through.
        let proto = protocolConfiguration as? NETunnelProviderProtocol
        return proto?.providerConfiguration?["config"] as? String
    }
}

/// Socket protection is Android's problem, not ours.
///
/// There it stops xray's own connection to the node being routed back
/// into the tunnel it is serving. iOS already excludes the extension's
/// own sockets, so there is nothing to do -- but the engine's signature
/// is shared, so something has to be passed. Returning true says
/// "protected", which on this platform is true by default.
// `...Protocol` and not `NeoxifyxrayProtector`: gomobile emits both a
// class and a protocol of that name, and Swift renames the protocol to
// break the collision. Conforming to the class instead is the error
// the compiler reports as multiple inheritance.
private final class NoopProtector: NSObject, NeoxifyxrayProtectorProtocol {
    func protect(_ fd: Int) -> Bool { true }
}

enum TunnelError: LocalizedError {
    case missingConfiguration
    case noTunnelDescriptor
    case engineFailed

    var errorDescription: String? {
        switch self {
        case .missingConfiguration: "No VPN configuration was supplied to the tunnel."
        case .noTunnelDescriptor: "The tunnel started but its network interface could not be found."
        case .engineFailed: "The VPN engine failed to start."
        }
    }
}
