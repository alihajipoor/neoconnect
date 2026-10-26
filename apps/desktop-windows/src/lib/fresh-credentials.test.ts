import { describe, expect, it } from "vitest";
import { credentialChanged, freshCopyOf, onFreshCredentials } from "./fresh-credentials";
import type { ProtocolUser } from "./types";

const credential = (id: string, routeId: string, secret: string, protocol: ProtocolUser["protocol"] = "XRAY_VLESS_REALITY") =>
  ({
    id,
    subscriptionId: "sub",
    routeId,
    protocol,
    status: "ACTIVE",
    credentials: { uuid: secret },
    connection: { host: "203.0.113.5", port: 443, publicParams: {} },
  }) as unknown as ProtocolUser;

describe("fresh credentials in the middle of a pass", () => {
  it("finds each credential's copy by id, or by its subscription, route and protocol when the server replaced it", () => {
    const old = credential("a", "r1", "s1");
    expect(freshCopyOf(old, [credential("a", "r1", "s2")])?.id).toBe("a");
    expect(freshCopyOf(old, [credential("b", "r1", "s3")])?.id).toBe("b");
    expect(freshCopyOf(old, [credential("c", "r2", "s1")])).toBeNull();
  });

  it("tells a changed credential from the same one", () => {
    expect(credentialChanged(credential("a", "r1", "s1"), credential("a", "r1", "s1"))).toBe(false);
    expect(credentialChanged(credential("a", "r1", "s1"), credential("a", "r1", "s2"))).toBe(true);
    expect(credentialChanged(credential("a", "r1", "s1"), credential("b", "r1", "s1"))).toBe(true);
  });

  it("dials a rung that carried nothing again on its new credential, first, then the rest on theirs", () => {
    const refused = credential("a", "r1", "old-secret");
    const next = credential("x", "r2", "s");
    const last = credential("y", "r3", "s", "OPENVPN");
    const fresh = [credential("b", "r1", "new-secret"), credential("x", "r2", "s2")];
    const ladder = onFreshCredentials([next, last], [refused], fresh);
    expect(ladder.map((u) => u.id)).toEqual(["b", "x", "y"]);
    // The rest on their fresh copies, and one the answer does not hold kept
    // as it was: never dropped.
    expect(ladder[1].credentials).toEqual({ uuid: "s2" });
    expect(ladder[2]).toBe(last);
  });

  it("does not dial again a rung whose credential has not changed, nor one twice", () => {
    const refused = credential("a", "r1", "s1");
    expect(onFreshCredentials([], [refused], [credential("a", "r1", "s1")])).toEqual([]);
    const changed = credential("a", "r1", "s9");
    const ladder = onFreshCredentials([refused], [refused, refused], [changed]);
    expect(ladder.map((u) => u.id)).toEqual(["a"]);
    expect(ladder[0].credentials).toEqual({ uuid: "s9" });
  });
});
