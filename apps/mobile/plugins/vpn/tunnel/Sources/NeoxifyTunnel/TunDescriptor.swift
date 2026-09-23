import Foundation

/// Finds the utun descriptor the system handed this extension.
///
/// NEPacketTunnelProvider does not expose it. It gives `packetFlow`, an
/// object API, and keeps the descriptor private -- but the descriptor is
/// open in this process, so it can be found by asking each one what it
/// is. Every iOS client that runs a real network stack rather than
/// Apple's does some version of this.
///
/// Why bother, rather than pumping `packetFlow` into the engine by hand:
/// xray-core's darwin tun inbound already accepts a descriptor, put there
/// for exactly this case -- `// iOS: use provided fd from
/// NetworkExtension`. Handing it the descriptor uses the same supported
/// path the Android build uses, and leaves gVisor to do the work. Copying
/// packets across a Swift bridge instead would add a hop, a queue and a
/// second place for MTU and IP-version bugs to live.
///
/// This is the one genuinely fragile part of the iOS port, so it fails
/// loudly rather than guessing: a wrong descriptor would not error, it
/// would silently carry nothing.
enum TunDescriptor {
    /// `getsockopt` on a utun socket answers with its interface name.
    /// A socket that is not utun fails, which is the test.
    private static func interfaceName(of fd: Int32) -> String? {
        var buffer = [CChar](repeating: 0, count: Int(IFNAMSIZ))
        var length = socklen_t(buffer.count)
        // 2 = SYSPROTO_CONTROL, 2 = UTUN_OPT_IFNAME. Named here because
        // the constants are not exposed to Swift.
        let result = getsockopt(fd, 2, 2, &buffer, &length)
        guard result == 0 else { return nil }
        return String(cString: buffer)
    }

    /// The descriptor of the tunnel this extension was given.
    ///
    /// Scans upward from 0. The range is bounded rather than open: the
    /// descriptor is opened during tunnel setup, so it is low, and an
    /// unbounded scan in an extension with a tight memory budget is a
    /// worse failure than not finding it.
    static func current() -> Int32? {
        for fd in Int32(0)...Int32(1024) where interfaceName(of: fd)?.hasPrefix("utun") == true {
            return fd
        }
        return nil
    }
}
