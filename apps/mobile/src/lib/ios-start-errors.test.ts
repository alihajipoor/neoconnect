import { describe, expect, it, vi } from "vitest";

/** The iOS connect errors, as the ladder will read them.
 *
 * The Swift plugin now rejects an Xray or WireGuard connect when the
 * packet-tunnel extension did not start (ProviderStart in
 * NeoxifyVpnPlugin.swift), and the extension rejects a WireGuard
 * endpoint that does not resolve (TunnelError.endpointUnresolved). None
 * of those dialled a server, so none may classify as
 * `serverUnreachable`: that kind is what `failedDial` turns into a
 * `carried: false` rung, remembered as a failing route on this network
 * and reported to the per-ISP data.
 *
 * The strings are copied from the Swift by hand -- there is no Swift
 * build here -- so this pins the contract rather than the code: change
 * the wording there and this is where to check it still reads as a
 * local fault. */

vi.mock("@shared/lib/api", () => ({
  apiRequest: () => Promise.resolve({ ok: false, error: "not used" }),
  publicRequest: () => Promise.resolve({ ok: false, error: "not used" }),
}));

const { classifyConnectionError } = await import("@shared/lib/connection-errors");
const { failedDial } = await import("@shared/lib/attempts");

const trail = "disconnected -> connecting -> disconnected";
const MESSAGES = [
  `could not start the tunnel: the Xray tunnel extension did not start on this device: the system gave no reason (${trail})`,
  `could not start WireGuard: the WireGuard tunnel extension did not start on this device: This server's WireGuard address could not be looked up on this network. (${trail})`,
  "could not start the tunnel: the Xray tunnel extension had not finished starting after 20 seconds (disconnected -> connecting)",
  `could not start WireGuard: the WireGuard tunnel extension did not start on this device: The WireGuard keys in this profile are not valid. (${trail})`,
];

/** The same failures carrying a reason from the system's
 * `fetchLastDisconnectError`, which is Apple's text or the extension's
 * own error and is not pinned anywhere. Before the classifier looked at
 * the wrapper first, a reason saying "timed out" or "handshake" read as
 * serverUnreachable -- a carried:false rung against a route nothing had
 * dialled -- and others borrowed a Windows sentence ("expired" as an
 * inactive subscription, "not running" as the background service). */
const SYSTEM_REASONS = [
  "The operation timed out.",
  "The VPN session failed because an internal error occurred: handshake not completed.",
  "Connection refused by the system.",
  "The configuration has expired.",
  "The VPN app is not running.",
];

describe("iOS extension start failures", () => {
  for (const message of MESSAGES) {
    it(`is a local fault, not a failed route: ${message.slice(0, 60)}...`, () => {
      const classified = classifyConnectionError(message);
      expect(classified.kind).not.toBe("serverUnreachable");
      expect(failedDial("route-1", classified.kind)).toBeNull();
    });
  }

  for (const reason of SYSTEM_REASONS) {
    it(`stays a local fault whatever the system's reason says: ${reason}`, () => {
      for (const engine of ["Xray", "WireGuard"]) {
        const classified = classifyConnectionError(
          `could not start the tunnel: the ${engine} tunnel extension did not start on this device: ${reason} (${trail})`,
        );
        expect(classified.kind).toBe("unknown");
        expect(failedDial("route-1", classified.kind)).toBeNull();
      }
    });
  }

  it("leaves a server that really timed out where it was", () => {
    // The wrapper is what is recognised, not the words inside it.
    expect(classifyConnectionError("connection timed out").kind).toBe("serverUnreachable");
  });
});
