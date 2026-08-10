import { HealthController } from "./health.controller";
import type { PrismaService } from "../../prisma/prisma.service";
import type { Request } from "express";

/** The client compares this value before and after connecting to prove
 * its traffic actually moved. Returning a proxy's address instead of the
 * caller's makes both readings identical, which the app correctly reads
 * as "the tunnel is carrying nothing" -- reporting every working
 * connection as unprotected. */
describe("HealthController.ip", () => {
  const controller = new HealthController({} as PrismaService);
  const ask = (headers: Record<string, string>, socketIp = "10.0.0.1") =>
    controller.ip(socketIp, { headers } as unknown as Request).ip;

  it("returns the socket address when nothing is proxying", () => {
    expect(ask({})).toBe("10.0.0.1");
  });

  /** Measured against production: through the CDN this returned
   * 162.158.41.5 while the caller was 50.47.175.127. */
  it("prefers Cloudflare's header over the hop it arrived from", () => {
    expect(
      ask({
        "cf-connecting-ip": "50.47.175.127",
        "x-forwarded-for": "50.47.175.127, 162.158.41.5",
        "x-real-ip": "162.158.41.5",
      }),
    ).toBe("50.47.175.127");
  });

  /** A node's API mirror adds a hop, so the chain grows on the right.
   * The client stays leftmost. */
  it("takes the client end of a forwarded chain, not the last proxy", () => {
    expect(
      ask({ "x-forwarded-for": "50.47.175.127, 204.168.161.100", "x-real-ip": "204.168.161.100" }),
    ).toBe("50.47.175.127");
  });

  /** X-Real-IP is the immediate peer, which is only the client when
   * nothing else forwarded the request. */
  it("falls back to X-Real-IP when there is no forwarded chain", () => {
    expect(ask({ "x-real-ip": "50.47.175.127" })).toBe("50.47.175.127");
  });
});
