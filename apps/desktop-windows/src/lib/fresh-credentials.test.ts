import { describe, expect, it } from "vitest";
import { createFreshAsk, credentialChanged, FRESH_ASKS, freshCopyOf, onFreshCredentials } from "./fresh-credentials";
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

// Round 4: the ask went into the tunnel of the rung that had carried
// nothing, failed there, and was never asked again in that pass.
describe("the pass's ask for fresh credentials", () => {
  type Reply = { source: string; protocolUsers: ProtocolUser[] };
  function asker() {
    const replies: ((reply: Reply) => void)[] = [];
    const answered: ProtocolUser[][] = [];
    const fresh = createFreshAsk(
      () => new Promise<Reply>((resolve) => replies.push(resolve)),
      (users) => answered.push(users),
    );
    return { fresh, replies, answered };
  }
  const settle = async (pending: Promise<void> | null) => {
    await pending;
  };

  it("asks only when asked to -- once a tunnel is down -- and never twice at once", async () => {
    const { fresh, replies } = asker();
    expect(replies).toHaveLength(0);
    expect(fresh.pending()).toBeNull();
    fresh.ask();
    fresh.ask();
    expect(replies).toHaveLength(1);
    expect(fresh.pending()).not.toBeNull();
    const pending = fresh.pending();
    replies[0]({ source: "network", protocolUsers: [credential("b", "r1", "s2")] });
    await settle(pending);
    expect(fresh.pending()).toBeNull();
  });

  it("asks once more when the answer did not come from the server, and no more than that", async () => {
    const { fresh, replies, answered } = asker();
    fresh.ask();
    let pending = fresh.pending();
    replies[0]({ source: "stale", protocolUsers: [] });
    await settle(pending);
    expect(fresh.take()).toBeNull();
    fresh.ask();
    expect(replies).toHaveLength(2);
    pending = fresh.pending();
    replies[1]({ source: "stale", protocolUsers: [] });
    await settle(pending);
    fresh.ask();
    expect(replies).toHaveLength(FRESH_ASKS);
    expect(answered).toEqual([]);
  });

  it("hands the server's answer over once, and asks nothing after it", async () => {
    const { fresh, replies, answered } = asker();
    fresh.ask();
    const pending = fresh.pending();
    const users = [credential("b", "r1", "new-secret")];
    replies[0]({ source: "network", protocolUsers: users });
    await settle(pending);
    expect(answered).toEqual([users]);
    expect(fresh.take()).toBe(users);
    expect(fresh.take()).toBeNull();
    fresh.ask();
    expect(replies).toHaveLength(1);
  });
});
