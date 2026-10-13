import { describe, expect, it } from "vitest";
import { egressWorthAnotherLook } from "./confinement-recheck";

/** A rung judged on one egress check, while the service's plan-error valve
 * let go of the rung's own confinement during it. */
describe("a second egress check after the confinement was let go of", () => {
  const up = (ipv4Confined: boolean | null | undefined) => ({ connected: true, ipv4Confined });

  it("is owed when the confinement went from held to let go of during a failed check", () => {
    for (const state of ["unreachable", "bypassingTunnel", "inconclusive"]) {
      expect(egressWorthAnotherLook(true, up(false), state), state).toBe(true);
    }
  });

  it("is not owed otherwise", () => {
    expect(egressWorthAnotherLook(true, up(false), "throughTunnel"), "the check passed").toBe(false);
    expect(egressWorthAnotherLook(true, up(true), "unreachable"), "still held: the network's doing").toBe(false);
    expect(egressWorthAnotherLook(false, up(false), "unreachable"), "never held").toBe(false);
    expect(egressWorthAnotherLook(null, up(false), "unreachable"), "not a confined session").toBe(false);
    expect(egressWorthAnotherLook(undefined, up(false), "unreachable"), "not read").toBe(false);
    expect(egressWorthAnotherLook(true, { connected: false, ipv4Confined: false }, "unreachable"), "the tunnel is gone").toBe(false);
    expect(egressWorthAnotherLook(true, null, "unreachable"), "the service did not answer").toBe(false);
  });
});
