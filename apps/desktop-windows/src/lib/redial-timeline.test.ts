import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LATE_SETTLE_GRACE_MS, settleBeside } from "./baseline-settle";
import type { BaselineIp } from "./egress";
import { CAUTION_AFTER_MS } from "./orb-caution";

/** The redial after a short unplug, on a timeline (the VM, round 3: five
 * 3 s unplugs, verified again at +24 s each). The service's way-out turned
 * true at +7.6 to +8.0 s, and the dial then waited for the settle's first
 * answer off the tunnel, +8.7 to +10.3 s. Measured there: the settle's
 * first answer 1.6 s after the way-out, the connect 2.5 s, and the first
 * check through the tunnel 2.0 s after it was up.
 *
 * The settle now runs beside the dial (`settleBeside`): its baseline is
 * taken when it was in before the tunnel was up, and a rung dialled so
 * whose settle said nothing is dialled again with the settle in front --
 * never held against its server. The calm hold is not lengthened for it. */

const HOME: BaselineIp = { ip: "192.0.2.228", from: "https://origin.example.test/api" } as BaselineIp;
const WAY_OUT_AT = 7_800;
const SETTLE_MS = 1_600;
const CONNECT_MS = 2_500;
const CHECK_MS = 2_000;

const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One redial from the moment the way-out turns true: when it dials, when
 * its tunnel is up, when it is verified, and the baseline its check uses. */
async function redial({ beside, settleMs = SETTLE_MS, settled = HOME }: { beside: boolean; settleMs?: number; settled?: BaselineIp | null }) {
  const start = Date.now();
  const at = () => WAY_OUT_AT + (Date.now() - start);
  const settling = after(settleMs).then(() => settled);
  let baseline: BaselineIp | null;
  let dialAt: number;
  if (beside) {
    const settle = settleBeside(settling);
    dialAt = at();
    await after(CONNECT_MS);
    baseline = await settle.found();
  } else {
    baseline = await settling;
    dialAt = at();
    await after(CONNECT_MS);
  }
  const upAt = at();
  await after(CHECK_MS);
  return { dialAt, upAt, verifiedAt: at(), baseline };
}

async function run<T>(work: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return work;
}

describe("the redial after a short unplug", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dials the moment the way-out is true, not when the settle answers, with the settle's own baseline", async () => {
    const before = await run(redial({ beside: false }));
    const now = await run(redial({ beside: true }));
    expect(before.dialAt).toBe(WAY_OUT_AT + SETTLE_MS);
    expect(now.dialAt).toBe(WAY_OUT_AT);
    expect(now.verifiedAt).toBe(before.verifiedAt - SETTLE_MS);
    expect(now.verifiedAt).toBe(12_300);
    // The check still compares against the bare line's address.
    expect(now.baseline).toEqual(HOME);
    // Over the calm hold still, on the VM -- whose DHCP alone takes six
    // seconds -- and the hold is not lengthened to hide it.
    expect(CAUTION_AFTER_MS).toBe(10_000);
  });

  it("waits a moment more for a settle not in when the tunnel is up, and no longer", async () => {
    const slow = await run(redial({ beside: true, settleMs: CONNECT_MS + 1_000 }));
    expect(slow.dialAt).toBe(WAY_OUT_AT);
    expect(slow.baseline).toEqual(HOME);
    expect(slow.verifiedAt).toBe(WAY_OUT_AT + CONNECT_MS + 1_000 + CHECK_MS);
    const late = await run(redial({ beside: true, settleMs: CONNECT_MS + LATE_SETTLE_GRACE_MS + 1 }));
    expect(late.baseline).toBeNull();
  });

  it("takes none from a settle that found nothing reachable", async () => {
    const dead = await run(redial({ beside: true, settled: null }));
    expect(dead.baseline).toBeNull();
  });
});

describe("the Windows ladder's redial", () => {
  const dash = readFileSync(fileURLToPath(new URL("../screens/Dashboard.tsx", import.meta.url)), "utf8");
  const ladder = dash.slice(dash.indexOf("async function runLadder("));
  const loop = ladder.slice(ladder.indexOf("for (let index = 0; index < candidates.length; index += 1) {"));

  it("runs the settle beside the dial after a wait the way-out ended, and in front of it otherwise", () => {
    const prologue = loop.slice(0, loop.indexOf('const dial = invoke("vpn_connect", {'));
    expect(prologue).toContain("const dialEarly = redialAfterWait && !settleInFront;");
    expect(prologue).toContain("const beside = dialEarly ? settleBeside(settling) : null;");
    expect(prologue).toContain("if (beside === null) {\n          baselineIpRef.current = await settling;");
    expect(prologue.split("await settling").length - 1).toBe(1);
    expect(prologue).toContain("if (ipv6BaselineRef.current === null && beside === null) {");
  });

  it("takes the settle's baseline once the dial has answered, before the check", () => {
    const dialled = loop.indexOf("await dialledUnderHold(dial);");
    const taken = loop.indexOf("baselineIpRef.current = await beside.found();");
    expect(taken).toBeGreaterThan(dialled);
    expect(taken).toBeLessThan(loop.indexOf("let egress = await confirmEgress("));
  });

  it("dials a rung again, the settle in front, when it failed with the settle never having said the network worked", () => {
    const bottom = loop.slice(loop.indexOf('await invoke(holdThrough ? "vpn_disconnect_for_reconnect" : "vpn_disconnect")'));
    const again = bottom.slice(0, bottom.indexOf("takeFresh(index + 1);"));
    expect(again).toContain("(dialAnswered ? baselineIpRef.current === null : (await beside.found()) === null)");
    for (const step of ["attempts.pop();", "dials.pop();", "failedRungs.pop();", "settleInFront = true;", "index -= 1;", "continue;"]) {
      expect(again).toContain(step);
    }
  });
});
