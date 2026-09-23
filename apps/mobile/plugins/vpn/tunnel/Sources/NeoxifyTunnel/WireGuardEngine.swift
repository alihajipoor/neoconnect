import Foundation
import NeoxifyXray

/// The WireGuard half of the tunnel.
///
/// Same framework as Xray and the same descriptor handling -- what
/// differs is the configuration format and the network settings, both
/// of which come from the profile rather than being fixed.
enum WireGuardEngine {
    /// The profile as the backend issues it.
    ///
    /// Field names are the backend's, matching the Rust `WireGuardProfile`
    /// exactly, including `allowedIPs` keeping its wg-quick casing. The
    /// reasoning is written out there: a mapping layer whose only job is
    /// to rename things is a layer that eventually renames one wrong.
    struct Profile: Decodable {
        let privateKey: String
        let address: String
        let dns: String
        let serverPublicKey: String
        let endpoint: String
        let allowedIPs: String
    }

    /// wireguard-go's UAPI wants keys as hex; WireGuard's own tooling,
    /// and so the backend, emits base64. The conversion is not optional
    /// and not detectable if skipped -- a base64 key is accepted as a
    /// string and produces a tunnel that handshakes with nobody.
    private static func hexKey(_ base64: String) throws -> String {
        guard let data = Data(base64Encoded: base64), data.count == 32 else {
            throw TunnelError.badWireGuardKey
        }
        return data.map { String(format: "%02x", $0) }.joined()
    }

    /// Builds the UAPI configuration.
    ///
    /// Only the cryptographic and peer settings go here. Addresses, DNS
    /// and routes are deliberately absent: on iOS those belong to
    /// NEPacketTunnelNetworkSettings, which the provider applies before
    /// the engine starts. This is wireguard-go's own format, not
    /// wg-quick's ini file, and wg-quick keys would simply be rejected.
    static func uapi(from profile: Profile) throws -> String {
        var lines = [
            "private_key=\(try hexKey(profile.privateKey))",
            // Ephemeral. A fixed port would be one more fingerprint for a
            // censor to match on, and nothing dials us.
            "listen_port=0",
            "replace_peers=true",
            "public_key=\(try hexKey(profile.serverPublicKey))",
            "endpoint=\(profile.endpoint)",
            // Without this a NAT on the path drops the mapping while the
            // phone is idle and the tunnel silently stops carrying
            // anything until the next packet from this side. 25s is
            // WireGuard's own recommendation.
            "persistent_keepalive_interval=25",
            "replace_allowed_ips=true",
        ]
        for cidr in split(profile.allowedIPs) {
            lines.append("allowed_ip=\(cidr)")
        }
        return lines.joined(separator: "\n") + "\n"
    }

    /// Comma-separated lists, trimmed. The backend emits them the way
    /// wg-quick writes them, spaces and all.
    static func split(_ value: String) -> [String] {
        value.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    /// Splits `10.66.0.5/32` into an address and a mask.
    ///
    /// NEIPv4Settings takes a dotted netmask, not a prefix length, so the
    /// conversion has to happen somewhere. A missing prefix is treated as
    /// /32 rather than rejected: a bare address is what a hand-edited
    /// profile tends to carry, and a single host is the safe reading.
    static func addressAndMask(_ value: String) -> (address: String, mask: String)? {
        let parts = value.split(separator: "/", maxSplits: 1)
        guard let address = parts.first, !address.isEmpty else { return nil }
        let prefix = parts.count == 2 ? Int(parts[1]) ?? 32 : 32
        guard (0...32).contains(prefix) else { return nil }
        let bits = prefix == 0 ? UInt32(0) : UInt32.max << (32 - UInt32(prefix))
        let mask = (0..<4).map { String((bits >> (24 - 8 * UInt32($0))) & 0xff) }.joined(separator: ".")
        return (String(address), mask)
    }

    static func start(profile: Profile, descriptor: Int32, mtu: Int) throws {
        var error: NSError?
        let started = NeoxifyxrayWireGuardStart(try uapi(from: profile), Int(descriptor), mtu, &error)
        if !started {
            throw error ?? TunnelError.engineFailed
        }
    }

    static func stop() -> NSError? {
        var error: NSError?
        _ = NeoxifyxrayWireGuardStop(&error)
        return error
    }
}
