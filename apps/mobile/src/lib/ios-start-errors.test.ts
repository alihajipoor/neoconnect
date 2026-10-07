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

describe("iOS extension start failures", () => {
  for (const message of MESSAGES) {
    it(`is a local fault, not a failed route: ${message.slice(0, 60)}...`, () => {
      const classified = classifyConnectionError(message);
      expect(classified.kind).not.toBe("serverUnreachable");
      expect(failedDial("route-1", classified.kind)).toBeNull();
    });
  }
});
