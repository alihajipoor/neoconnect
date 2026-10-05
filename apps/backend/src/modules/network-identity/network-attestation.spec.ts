import { ATTESTATION_TTL_SECONDS, networkAttestor } from "./network-attestation";

/** The per-ISP tags count what people on a network experienced, so the
 * network on a report must be one the server saw, not one the client
 * claims. */
describe("networkAttestor", () => {
  const now = Date.UTC(2026, 9, 5, 12, 0, 0);
  const attestor = networkAttestor("test-secret-not-a-real-one");

  it("verifies its own token", () => {
    expect(attestor.verify(attestor.issue(64500, now), now)).toBe(64500);
  });

  it("refuses a token whose network was edited", () => {
    const token = attestor.issue(64500, now)!;
    const forged = token.replace(".64500.", ".64501.");
    expect(attestor.verify(forged, now)).toBeNull();
  });

  it("refuses a token signed under another secret", () => {
    const other = networkAttestor("a-different-secret").issue(64500, now);
    expect(attestor.verify(other, now)).toBeNull();
  });

  /** A laptop carried to another network must stop speaking for the old
   * one; a day is the outer bound. */
  it("expires", () => {
    const token = attestor.issue(64500, now);
    expect(attestor.verify(token, now + (ATTESTATION_TTL_SECONDS - 60) * 1000)).toBe(64500);
    expect(attestor.verify(token, now + (ATTESTATION_TTL_SECONDS + 60) * 1000)).toBeNull();
  });

  it("refuses one from the future beyond clock skew", () => {
    expect(attestor.verify(attestor.issue(64500, now + 3_600_000), now)).toBeNull();
  });

  it("refuses junk without throwing", () => {
    for (const junk of [undefined, null, "", "n1", "n1.a.b.c", "n2.64500.1.AAAA", "x".repeat(200)]) {
      expect(attestor.verify(junk, now)).toBeNull();
    }
  });

  /** With no secret configured there is nothing to sign with, and an
   * unsigned token would be a number anyone can type. */
  it("issues and accepts nothing without a secret", () => {
    const none = networkAttestor(undefined);
    expect(none.issue(64500, now)).toBeNull();
    expect(none.verify(attestor.issue(64500, now), now)).toBeNull();
  });

  /** It names a network and nothing else, so it can be joined to no one. */
  it("carries no address or person", () => {
    const token = attestor.issue(64500, now)!;
    expect(token.split(".")).toHaveLength(4);
    expect(token).toMatch(/^n1\.64500\.\d+\.[A-Za-z0-9_-]{22}$/);
  });
});
