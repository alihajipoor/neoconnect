import { Protocol } from "@prisma/client";
import { isShapeable, rateLimitFor, splitByShapeability } from "./rate-limit";

describe("per-plan rate limits", () => {
  const capped = { maxDownloadMbps: 100, maxUploadMbps: 20 };

  it("passes the plan's caps through for protocols that give each user an address", () => {
    expect(rateLimitFor(capped, Protocol.WIREGUARD)).toEqual({ downloadMbps: 100, uploadMbps: 20 });
    expect(rateLimitFor(capped, Protocol.OPENVPN)).toEqual({ downloadMbps: 100, uploadMbps: 20 });
  });

  it("sends no limit for Xray, because shaping it would throttle everyone on the node", () => {
    // Every VLESS user shares one xray process and one outbound, so there
    // is nothing per-user to shape. Silently applying a node-wide shaper
    // would punish every other customer for one person's plan.
    expect(rateLimitFor(capped, Protocol.XRAY_VLESS_REALITY)).toEqual({});
    expect(isShapeable(Protocol.XRAY_VLESS_REALITY)).toBe(false);
  });

  it("omits the fields entirely when uncapped rather than sending zero", () => {
    // A zero would read as "limit of 0" to the agent and cut the customer
    // off completely -- the difference between unlimited and unusable.
    const uncapped = { maxDownloadMbps: null, maxUploadMbps: null };
    expect(rateLimitFor(uncapped, Protocol.WIREGUARD)).toEqual({});
    expect(rateLimitFor(null, Protocol.WIREGUARD)).toEqual({});
  });

  it("carries one direction when only one is capped", () => {
    const downOnly = { maxDownloadMbps: 50, maxUploadMbps: null };
    expect(rateLimitFor(downOnly, Protocol.WIREGUARD)).toEqual({ downloadMbps: 50 });
  });

  it("tells the panel which of a plan's protocols the cap will not reach", () => {
    const { shapeable, unenforceable } = splitByShapeability([
      Protocol.WIREGUARD,
      Protocol.XRAY_VLESS_REALITY,
      Protocol.OPENVPN,
    ]);
    expect(shapeable).toEqual([Protocol.WIREGUARD, Protocol.OPENVPN]);
    expect(unenforceable).toEqual([Protocol.XRAY_VLESS_REALITY]);
  });
});
