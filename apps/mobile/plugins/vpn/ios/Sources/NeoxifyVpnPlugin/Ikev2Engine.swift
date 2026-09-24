import Foundation
import NetworkExtension
import Security

/// IKEv2 through iOS's own VPN client.
///
/// The odd engine out, exactly as on Android and Windows: nothing of
/// ours carries a packet. iOS has spoken IKEv2 natively since 8, so
/// this hands the system a profile and asks it to dial. There is no
/// packet-tunnel extension in the path, no TUN descriptor we hold, and
/// no Xray engine loaded -- which is also why it is the one protocol
/// here with no ~50MB extension memory ceiling over it.
///
/// It uses `NEVPNManager.shared()`, the single built-in "Personal VPN"
/// slot, which is a different store from the `NETunnelProviderManager`
/// profiles the Xray tunnel uses. The two coexist in Settings and only
/// one can be connected at a time. That separation is why `status` and
/// `disconnect` in the plugin have to consult both: asking only the
/// tunnel-provider side would report a live IKEv2 connection as
/// disconnected.
enum Ikev2Engine {
    /// Where the EAP password lives.
    ///
    /// It cannot be handed to `NEVPNProtocolIKEv2` directly. The class
    /// takes a `passwordReference`, which is a *persistent* keychain
    /// reference -- the system VPN daemon reads the secret itself, out
    /// of process, so a plain string would have nowhere to be read
    /// from. Passing a normal `SecKeychainItem` ref instead of a
    /// persistent one is accepted at save time and fails at dial time.
    private static let account = "neoxify-ikev2"
    private static let service = "com.neoxify.mobile.ikev2"

    /// How we recognise our own profile again.
    ///
    /// One constant because it is written in one place and read in
    /// another, and the two have to agree: `loadedIfOurs` decides whether
    /// a live personal VPN is ours by comparing against it. Two literals
    /// that drift apart would not fail to build -- `status` would simply
    /// start answering `.invalid` for a tunnel that is up, and
    /// `disconnect` would quietly stop stopping it.
    private static let profileName = "Neoxify IKEv2"

    /// Stores the password and returns the persistent reference.
    ///
    /// Deletes first rather than updating: the credential is reissued
    /// per connection by the backend, and `SecItemUpdate` cannot return
    /// a persistent ref, so an update would leave us with a stale one.
    private static func storePassword(_ password: String) throws -> Data {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)

        var add = base
        add[kSecValueData as String] = Data(password.utf8)
        add[kSecReturnPersistentRef as String] = true
        // The VPN daemon reads this while the device is locked if the
        // tunnel is brought up on demand, so it must survive a lock.
        // kSecAttrAccessibleAfterFirstUnlock is the weakest setting that
        // does; WhenUnlocked would fail silently in exactly that case.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

        var result: CFTypeRef?
        let status = SecItemAdd(add as CFDictionary, &result)
        guard status == errSecSuccess, let reference = result as? Data else {
            throw NSError(
                domain: "NeoxifyIkev2", code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: "could not store the VPN password (keychain status \(status))"])
        }
        return reference
    }

    /// Installs the profile and dials it, resolving only once the
    /// tunnel is actually up.
    ///
    /// The wait is the point. `startVPNTunnel()` returns the instant the
    /// request is accepted, long before any packet has been exchanged,
    /// and every caller above treats a resolved connect as "this
    /// protocol works". Returning there would report success for a
    /// server that is refusing the credential -- the same reasoning
    /// that made the Android engine wait.
    static func connect(server: String, username: String, password: String) async throws {
        let manager = NEVPNManager.shared()
        try await manager.loadFromPreferences()

        let proto = NEVPNProtocolIKEv2()
        proto.serverAddress = server
        // Both the address and the identity, matching the Android
        // profile. The node presents a Let's Encrypt certificate for its
        // real name, so the system trust store is the right anchor and
        // no issuer is pinned -- pinning ours would mean shipping a CA
        // and rotating it in every installed app every ninety days.
        proto.remoteIdentifier = server
        proto.localIdentifier = username
        // EAP-MSCHAPv2. `.none` reads as "no machine authentication",
        // which is what extended authentication replaces; setting it to
        // .sharedSecret or .certificate here would make iOS demand a
        // secret or an identity that does not exist.
        proto.authenticationMethod = .none
        proto.useExtendedAuthentication = true
        proto.username = username
        proto.passwordReference = try storePassword(password)
        proto.disconnectOnSleep = false

        manager.protocolConfiguration = proto
        manager.localizedDescription = profileName
        manager.isEnabled = true
        // Cleared rather than left alone. On-demand rules make iOS
        // bring the tunnel back by itself on a network change, so a
        // profile that carried them from an earlier configuration would
        // reconnect after the customer had pressed disconnect. It is
        // not the equivalent of Android's setBypassable(false) -- that
        // has no counterpart here, because traffic iOS routes into a
        // VPN cannot be opted out of by an app in the first place.
        manager.isOnDemandEnabled = false

        try await manager.saveToPreferences()
        // Reloaded before starting, for the reason the Xray path
        // documents: saving invalidates the in-memory object, and
        // starting the stale one fails with a permission error that has
        // nothing to do with permissions.
        try await manager.loadFromPreferences()
        try manager.connection.startVPNTunnel()

        try await waitUntilConnected(manager.connection)
    }

    /// Polls the connection until it is up, or gives up.
    ///
    /// Polling rather than observing `NEVPNStatusDidChange`: the
    /// notification is delivered on the main run loop, and the status
    /// can pass through .connected between two deliveries when the
    /// handshake is fast, leaving an observer waiting for an edge that
    /// has already gone by. Reading the property has no such race.
    ///
    /// Thirty seconds because an IKEv2 handshake across a congested
    /// path to Europe can take twenty, and a customer on a bad Iranian
    /// connection is exactly who this protocol is a fallback for. A
    /// wrong credential fails much sooner than that, so the full wait
    /// is only ever spent on a genuinely slow path.
    private static func waitUntilConnected(_ connection: NEVPNConnection) async throws {
        let start = Date()
        // Every status this connection passed through, in order.
        //
        // Kept because the two errors below used to be the only thing
        // that ever reached the customer, and they are guesses. A
        // connection that never leaves .disconnected failed before the
        // handshake -- a profile iOS would not install, a permission not
        // granted -- while one that reaches .connecting and drops back
        // failed *in* it, on the credential or the proposal. Those need
        // opposite fixes and produced identical text, which is why
        // "IKEv2 does not work on iOS" stayed unattributable through a
        // whole release. Bounded, so a slow path cannot grow it without
        // limit.
        var seen: [NEVPNStatus] = []
        // `startVPNTunnel` returns before the status leaves
        // .disconnected, so a failure cannot be believed immediately --
        // without this grace period every healthy connection would be
        // reported as refused on the first poll.
        let grace: TimeInterval = 1
        let limit: TimeInterval = 30

        while true {
            let elapsed = Date().timeIntervalSince(start)
            let status = connection.status
            if seen.last != status && seen.count < 32 { seen.append(status) }
            switch status {
            case .connected:
                return
            // Both patterns are guarded, spelled out rather than
            // written `case .invalid, .disconnected where ...`: a
            // `where` binds to the case item it follows, not to the
            // list, so that form would leave .invalid unguarded and
            // throw on the first poll of a connection that is fine.
            case .invalid where elapsed > grace, .disconnected where elapsed > grace:
                throw NSError(
                    domain: "NeoxifyIkev2", code: 1,
                    userInfo: [
                        NSLocalizedDescriptionKey:
                            seen.contains(.connecting)
                                // It negotiated and was turned away. The
                                // credential or the proposal, not the
                                // profile.
                                ? "the server refused the connection (\(trail(seen)))"
                                // It never began. Saying the server
                                // refused us would name a machine that
                                // was never dialled -- the failure is on
                                // this device.
                                : "iOS did not start the connection (\(trail(seen)))",
                    ])
            default:
                break
            }
            if elapsed > limit { break }
            try await Task.sleep(nanoseconds: 250_000_000)
        }

        connection.stopVPNTunnel()
        throw NSError(
            domain: "NeoxifyIkev2", code: 2,
            userInfo: [NSLocalizedDescriptionKey: "the connection timed out (\(trail(seen)))"])
    }

    /// The statuses a connection went through, for the error text.
    ///
    /// Spelled out rather than `String(describing:)` over the raw enum:
    /// NEVPNStatus is an ObjC enum and describes itself as a number, so
    /// the trail would read "0, 1, 0" in the one place it exists to be
    /// read by somebody trying to explain a failure.
    private static func trail(_ statuses: [NEVPNStatus]) -> String {
        let name: (NEVPNStatus) -> String = {
            switch $0 {
            case .invalid: return "invalid"
            case .disconnected: return "disconnected"
            case .connecting: return "connecting"
            case .connected: return "connected"
            case .reasserting: return "reasserting"
            case .disconnecting: return "disconnecting"
            @unknown default: return "unknown"
            }
        }
        return statuses.isEmpty ? "no status observed" : statuses.map(name).joined(separator: " -> ")
    }

    /// Whether the live personal-VPN connection is ours.
    ///
    /// The profile outlives the app, so "a personal VPN is connected"
    /// is equally consistent with a different VPN app owning it.
    /// Reporting someone else's tunnel as ours would be a false
    /// "Connected" -- the dishonesty the Android engine keeps a
    /// preference flag to avoid. Here the description is enough,
    /// because iOS has one personal-VPN slot and whoever wrote it last
    /// also wrote its name.
    ///
    /// Loading first is not optional. `NEVPNManager.shared()` hands back
    /// an object whose properties are all nil until `loadFromPreferences`
    /// has populated it, so reading the description off a fresh one
    /// answers "not ours" for a profile that is in fact ours and
    /// connected.
    private static func loadedIfOurs() async -> NEVPNManager? {
        let manager = NEVPNManager.shared()
        guard (try? await manager.loadFromPreferences()) != nil else { return nil }
        return manager.localizedDescription == profileName ? manager : nil
    }

    static func status() async -> NEVPNStatus {
        await loadedIfOurs()?.connection.status ?? .invalid
    }

    static func disconnect() async {
        await loadedIfOurs()?.connection.stopVPNTunnel()
    }
}
