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
// @objc, and with an explicit name: NSExtensionPrincipalClass in the
// Info.plist is resolved through the Objective-C runtime. Without this
// the runtime looks for a Swift-mangled name, finds nothing, and the
// tunnel fails to start with no message saying why.
@objc(PacketTunnelProvider)
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
        /// Only for a stored profile written before the client began
        /// sending these, which is the one case where the provider has
        /// to choose. The client is the authority otherwise, and these
        /// match what it sends today -- a fallback that disagreed with
        /// it would be the original bug again, just rarer.
        static let fallbackMTU = 1400
        static let fallbackDNS = "1.1.1.1"
        /// 198.18.0.0/15 is the benchmarking range, chosen for the same
        /// reason the Windows client uses it: routable-looking, allocated
        /// to nobody, so it cannot collide with a customer's own network
        /// the way 10/8 or 192.168/16 routinely do.
        static let peer = "198.18.0.2"
        /// WireGuard's framing costs 80 bytes, so its inner MTU has to be
        /// lower than Xray's. Leaving it at 1500 fragments every full-size
        /// packet, which shows up as "slow" rather than as broken.
        static let wireGuardMTU = 1420
    }

    /// What the app asked for.
    ///
    /// Two engines behind one provider, because iOS allows a packet
    /// tunnel extension exactly one principal class -- a second protocol
    /// cannot mean a second extension. The engines themselves are both
    /// in the one framework for the same kind of reason: see the build
    /// constraint note in wireguard_darwin.go.
    private enum Request {
        /// The engine config, plus the two settings the client chooses
        /// rather than this file: they are the same TUN_DNS and TUN_MTU
        /// that go inside the xray config, and the tunnel interface has
        /// to agree with the engine's own endpoint about them.
        case xray(config: String, dns: String, mtu: Int)
        case wireGuard(WireGuardEngine.Profile)
    }

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        let request: Request
        do {
            guard let parsed = try self.request(from: options) else {
                log.error("no configuration was passed to the tunnel")
                completionHandler(TunnelError.missingConfiguration)
                return
            }
            request = parsed
        } catch {
            log.error("the configuration passed to the tunnel could not be read: \(error.localizedDescription)")
            completionHandler(error)
            return
        }

        let settings: NEPacketTunnelNetworkSettings
        switch request {
        case .xray(_, let dns, let mtu):
            settings = xraySettings(dns: dns, mtu: mtu)
        case .wireGuard(let profile):
            guard let built = wireGuardSettings(for: profile) else {
                log.error("the WireGuard profile did not carry a usable address")
                completionHandler(TunnelError.badWireGuardAddress)
                return
            }
            settings = built
        }

        setTunnelNetworkSettings(settings) { [weak self] error in
            guard let self else { return }
            if let error {
                self.log.error("the system refused the tunnel settings: \(error.localizedDescription)")
                completionHandler(error)
                return
            }
            self.startEngine(request, completionHandler: completionHandler)
        }
    }

    /// Xray's settings are fixed, because nothing in an Xray profile
    /// describes the inside of the tunnel -- the engine terminates
    /// everything and the addresses are ours to choose.
    private func xraySettings(dns: String, mtu: Int) -> NEPacketTunnelNetworkSettings {
        let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: Tunnel.peer)
        let ipv4 = NEIPv4Settings(addresses: [Tunnel.address], subnetMasks: [Tunnel.netmask])
        // Everything, because this is a full tunnel. Split tunnelling on
        // iOS is per-app and belongs to the system, not to us: there is no
        // equivalent of the Windows client's per-app redirect here.
        ipv4.includedRoutes = [NEIPv4Route.default()]
        settings.ipv4Settings = ipv4
        // The client's, not a constant of ours. It hardcoded 1500 while
        // the engine's own tun inbound was configured for the client's
        // 1400, so the system handed xray packets its endpoint would not
        // take -- which presents as large transfers stalling rather than
        // as a tunnel that fails.
        settings.mtu = NSNumber(value: mtu)

        // Resolvers inside the tunnel, matching every other client: the
        // lookup has to travel the tunnel or the name leaks to whatever
        // network the device is on, which is the failure that was
        // reported from Iran as "the IP changes but the site will not
        // open".
        let resolvers = NEDNSSettings(servers: [dns])
        resolvers.matchDomains = [""]
        settings.dnsSettings = resolvers
        return settings
    }

    /// WireGuard's come from the profile, because the server assigned
    /// them. Using Tunnel.address here would put the phone on an address
    /// the peer has never heard of, and the handshake would succeed while
    /// nothing returned.
    private func wireGuardSettings(for profile: WireGuardEngine.Profile) -> NEPacketTunnelNetworkSettings? {
        guard let (address, mask) = WireGuardEngine.addressAndMask(profile.address) else { return nil }

        let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: Tunnel.peer)
        let ipv4 = NEIPv4Settings(addresses: [address], subnetMasks: [mask])
        // From allowedIPs, which is what the profile says this peer
        // carries. Usually 0.0.0.0/0, but honouring it rather than
        // assuming it is what makes a split profile behave.
        //
        // IPv4 only. Every profile the backend issues carries
        // "0.0.0.0/0, ::/0", and there is nowhere to put the IPv6 half:
        // it allocates a single IPv4 address inside the tunnel, and iOS
        // rejects IPv6 routes with no IPv6 settings to hang them on. The
        // ::/0 is still given to wireguard-go, where it means something
        // different and correct -- the peer's allowed source range.
        let cidrs = WireGuardEngine.split(profile.allowedIPs)
        for cidr in cidrs where WireGuardEngine.isIPv6(cidr) {
            log.info("not routing \(cidr, privacy: .public): the tunnel has no IPv6 address")
        }
        let routes = cidrs.compactMap { cidr -> NEIPv4Route? in
            guard let (network, netmask) = WireGuardEngine.addressAndMask(cidr) else { return nil }
            return NEIPv4Route(destinationAddress: network, subnetMask: netmask)
        }
        ipv4.includedRoutes = routes.isEmpty ? [NEIPv4Route.default()] : routes
        settings.ipv4Settings = ipv4
        // 1420, not 1500: WireGuard's own overhead is 80 bytes, and a
        // tunnel MTU that ignores it fragments every full-size packet.
        settings.mtu = NSNumber(value: Tunnel.wireGuardMTU)

        let servers = WireGuardEngine.split(profile.dns)
        let dns = NEDNSSettings(servers: servers.isEmpty ? ["1.1.1.1", "1.0.0.1"] : servers)
        dns.matchDomains = [""]
        settings.dnsSettings = dns
        return settings
    }

    /// Hands the descriptor to whichever engine was asked for.
    ///
    /// Only after `setTunnelNetworkSettings` has returned: the descriptor
    /// does not exist before the system has accepted the settings, so
    /// looking for it earlier finds nothing and the failure reads as a
    /// missing interface rather than a sequencing mistake.
    private func startEngine(_ request: Request, completionHandler: @escaping (Error?) -> Void) {
        guard let fd = TunDescriptor.current() else {
            log.error("the tunnel is up but its descriptor could not be found")
            completionHandler(TunnelError.noTunnelDescriptor)
            return
        }

        switch request {
        case .xray(let configJSON, _, _):
            var engineError: NSError?
            let started = NeoxifyxrayStart(configJSON, Int(fd), NoopProtector(), &engineError)
            if !started {
                let message = engineError?.localizedDescription ?? "unknown"
                log.error("xray-core did not start: \(message)")
                completionHandler(engineError ?? TunnelError.engineFailed)
                return
            }
        case .wireGuard(let profile):
            do {
                try WireGuardEngine.start(profile: profile, descriptor: fd, mtu: Tunnel.wireGuardMTU)
            } catch {
                log.error("WireGuard did not start: \(error.localizedDescription)")
                completionHandler(error)
                return
            }
        }

        log.info("tunnel up on descriptor \(fd)")
        completionHandler(nil)
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        log.info("stopping: \(String(describing: reason))")
        // Both engines, unconditionally. stopTunnel does not say which
        // one was started, the provider may have been restarted since,
        // and each stop is a no-op when that engine is not running --
        // so asking is more code and more ways to leave one up.
        var error: NSError?
        // Reported, not propagated: stopTunnel has nowhere to return a
        // failure, and the system is tearing this process down either way.
        if !NeoxifyxrayStop(&error), let error {
            log.error("xray-core did not stop cleanly: \(error.localizedDescription)")
        }
        if let error = WireGuardEngine.stop() {
            log.error("WireGuard did not stop cleanly: \(error.localizedDescription)")
        }
        completionHandler()
    }

    /// Reads whichever engine's configuration was supplied.
    ///
    /// Options first, then the provider configuration -- the latter is
    /// the path a tunnel started by the system, on demand or from
    /// Settings, comes through, where there are no start options at all.
    private func request(from options: [String: NSObject]?) throws -> Request? {
        let stored = (protocolConfiguration as? NETunnelProviderProtocol)?.providerConfiguration

        if let passed = options?["wireguard"] as? String, !passed.isEmpty {
            return .wireGuard(try decodeProfile(passed))
        }
        if let passed = options?["config"] as? String, !passed.isEmpty {
            return .xray(
                config: passed,
                dns: options?["dns"] as? String ?? Tunnel.fallbackDNS,
                mtu: (options?["mtu"] as? NSNumber)?.intValue ?? Tunnel.fallbackMTU,
            )
        }
        if let saved = stored?["wireguard"] as? String, !saved.isEmpty {
            return .wireGuard(try decodeProfile(saved))
        }
        if let saved = stored?["config"] as? String, !saved.isEmpty {
            return .xray(
                config: saved,
                dns: stored?["dns"] as? String ?? Tunnel.fallbackDNS,
                mtu: (stored?["mtu"] as? NSNumber)?.intValue ?? Tunnel.fallbackMTU,
            )
        }
        return nil
    }

    private func decodeProfile(_ json: String) throws -> WireGuardEngine.Profile {
        try JSONDecoder().decode(WireGuardEngine.Profile.self, from: Data(json.utf8))
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
    case badWireGuardKey
    case badWireGuardAddress

    var errorDescription: String? {
        switch self {
        case .missingConfiguration: "No VPN configuration was supplied to the tunnel."
        case .noTunnelDescriptor: "The tunnel started but its network interface could not be found."
        case .engineFailed: "The VPN engine failed to start."
        case .badWireGuardKey: "The WireGuard keys in this profile are not valid."
        case .badWireGuardAddress: "The WireGuard profile did not carry a usable address."
        }
    }
}
