import { describe, expect, it } from "vitest";
import { mirrorsFrom } from "./api-endpoints";

/** The mirrors are derived from credentials rather than configured, so
 * the derivation is the whole feature. Getting it wrong either loses the
 * fallback silently or sends the customer's requests somewhere that is
 * not us. */
describe("mirrorsFrom", () => {
  const user = (over: Record<string, unknown> = {}) => ({
    protocol: "XRAY_VLESS_TLS",
    connection: {
      port: 2053,
      security: "TLS",
      publicParams: { serverName: "fi1.neoxify.com" },
      ...over,
    },
  });

  it("builds a mirror from a TLS credential's own certificate name", () => {
    expect(mirrorsFrom([user()])).toEqual(["https://fi1.neoxify.com:2053/api"]);
  });

  /** REALITY proxies anything it does not recognise to the third-party
   * site it is imitating. A request there reaches somebody else's
   * server, not ours -- which is exactly what REALITY is for, and
   * exactly why it cannot host a mirror. */
  it("never derives a mirror from a REALITY credential", () => {
    expect(mirrorsFrom([user({ security: "REALITY", port: 443 })])).toEqual([]);
  });

  /** The node's bare IP does not match its certificate, so a mirror
   * built on one fails the TLS handshake before reaching nginx. Better
   * to have no mirror than one that always fails slowly. */
  it("skips a credential with no certificate name to use", () => {
    expect(mirrorsFrom([user({ publicParams: {} })])).toEqual([]);
  });

  it("does not offer the same node twice", () => {
    expect(mirrorsFrom([user(), user()])).toHaveLength(1);
  });

  /** WireGuard and OpenVPN have no HTTPS listener to fall back to. */
  it("ignores credentials that are not TLS-secured", () => {
    expect(mirrorsFrom([{ protocol: "WIREGUARD", connection: { port: 51820, security: "NONE" } }])).toEqual([]);
  });
});
