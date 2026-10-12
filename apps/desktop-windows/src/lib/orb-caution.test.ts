import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ConnectionState } from "../components/ConnectOrb";
import { CAUTION_AFTER_MS, CAUTION_GAP_MS, NO_CAUTION, nextCaution, orbTone, type CautionState } from "./orb-caution";

/** The owner's rule (2026-10-12): a few seconds of not being connected must
 * not change the button's colour, because people read a colour change as
 * "something is wrong" -- and many of them are in Iran, acting on it. So the
 * orb and the status dot take the warning colour only for a sustained, real
 * "connected, not fully protected": a confinement that would not go in, held
 * for CAUTION_AFTER_MS unbroken, or Built-in (IKEv2), which is never confined
 * in this version and so has no gap to wait out. A reconnect, a ladder rung,
 * an engine restart and the short unconfined gap after an engine crash keep
 * their own looks. The headline's words are not this file's: they say "not
 * fully protected" at once, as before. */

type Look = { state: ConnectionState; unconfined: boolean; byChoice?: boolean };

/** Plays `looks` one second apart from `at`, as the dashboard's tick does,
 * and returns what the orb showed after each. */
function play(looks: Look[], from: CautionState = NO_CAUTION, at = 1_000_000, every = 1_000) {
  let state = from;
  const shown: boolean[] = [];
  looks.forEach((look, i) => {
    state = nextCaution(state, { byChoice: false, ...look }, at + i * every);
    shown.push(state.caution);
  });
  return { state, shown };
}

const seconds = (n: number, look: Look): Look[] => Array.from({ length: n }, () => look);
const CONFINED: Look = { state: "connected", unconfined: false };
const UNCONFINED: Look = { state: "connected", unconfined: true };

describe("the orb's warning colour", () => {
  it("does not change for a three-second unconfined gap", () => {
    const { shown } = play([...seconds(5, CONFINED), ...seconds(3, UNCONFINED), ...seconds(20, CONFINED)]);
    expect(shown.every((caution) => caution === false)).toBe(true);
  });

  it("does not change for a gap just short of the threshold, either", () => {
    const short = Math.floor(CAUTION_AFTER_MS / 1_000) - 1;
    const { shown } = play([...seconds(2, CONFINED), ...seconds(short, UNCONFINED), ...seconds(5, CONFINED)]);
    expect(shown).not.toContain(true);
  });

  it("changes once 'not fully protected' has held unbroken for the threshold, and not before", () => {
    const { shown } = play(seconds(13, UNCONFINED));
    const threshold = CAUTION_AFTER_MS / 1_000;
    // Looks 0..threshold-1 are inside the first ten seconds.
    expect(shown.slice(0, threshold)).toEqual(Array(threshold).fill(false));
    expect(shown.slice(threshold)).toEqual(Array(13 - threshold).fill(true));
  });

  it("goes back only once the good condition has held as long, so it never flickers", () => {
    const { state: cautioned } = play(seconds(12, UNCONFINED));
    expect(cautioned.caution).toBe(true);
    // A three-second confined blip, then unconfined again: stays warning.
    const blip = play([...seconds(3, CONFINED), ...seconds(5, UNCONFINED)], cautioned, 2_000_000);
    expect(blip.shown).not.toContain(false);
    // Confined for good: back to the success colour after the threshold.
    const settled = play(seconds(12, CONFINED), cautioned, 3_000_000);
    const threshold = CAUTION_AFTER_MS / 1_000;
    expect(settled.shown.slice(0, threshold)).toEqual(Array(threshold).fill(true));
    expect(settled.shown.slice(threshold)).toEqual(Array(12 - threshold).fill(false));
  });

  it("counts only an unbroken stretch: a pause in the looks starts it again", () => {
    // Six seconds, then nothing seen for longer than the gap allowed --
    // Settings was open, the poll stalled -- then six more: twelve in all,
    // never ten seen in a row.
    const first = play(seconds(6, UNCONFINED));
    const after = play(seconds(6, UNCONFINED), first.state, 1_000_000 + 5_000 + CAUTION_GAP_MS + 1_000);
    expect([...first.shown, ...after.shown]).not.toContain(true);
  });

  it("keeps the reconnecting look through a reconnect, and the crash's unconfined gap changes nothing", () => {
    // An engine crash: the confinement is let go of on the drop report, the
    // status says so for a second or two while the screen still shows the
    // tunnel, then the drop is seen and the automatic reconnect runs.
    const looks: Look[] = [
      ...seconds(5, CONFINED),
      ...seconds(2, UNCONFINED),
      { state: "disconnected", unconfined: false },
      ...seconds(8, { state: "connecting", unconfined: false }),
      ...seconds(3, { state: "verifying", unconfined: false }),
      ...seconds(15, CONFINED),
    ];
    const { shown } = play(looks);
    expect(shown).not.toContain(true);
    // And while it runs the orb shows the busy look, whatever the caution.
    for (const state of ["connecting", "verifying", "disconnecting"] as ConnectionState[]) {
      expect(orbTone(state, true), state).toBe("busy");
      expect(orbTone(state, false), state).toBe("busy");
    }
  });

  it("does not carry a warning into a ladder rung's own looks", () => {
    // Rungs publish "connecting" and "verifying"; an unconfined reading
    // between them is never on screen as "connected" long enough.
    const looks: Look[] = [];
    for (let rung = 0; rung < 4; rung++) {
      looks.push(...seconds(4, { state: "connecting", unconfined: true }));
      looks.push(...seconds(4, { state: "verifying", unconfined: true }));
    }
    expect(play(looks).shown).not.toContain(true);
  });

  it("shows Built-in (IKEv2) in the warning colour steadily, from the moment it is connected", () => {
    const ikev2: Look = { state: "connected", unconfined: true, byChoice: true };
    const { shown } = play([
      ...seconds(3, { state: "connecting", unconfined: false }),
      ...seconds(2, { state: "verifying", unconfined: true, byChoice: true }),
      ...seconds(30, ikev2),
      { state: "unverified", unconfined: true, byChoice: true },
      ...seconds(10, ikev2),
    ]);
    const connectedFrom = 5;
    expect(shown.slice(0, connectedFrom)).not.toContain(true);
    expect(shown.slice(connectedFrom)).not.toContain(false);
  });

  it("starts afresh after a disconnect, so a new session is not coloured by the last one", () => {
    const { state: cautioned } = play(seconds(12, UNCONFINED));
    const { shown } = play(
      [
        { state: "disconnecting", unconfined: true },
        { state: "disconnected", unconfined: false },
        ...seconds(3, { state: "connecting", unconfined: false }),
        ...seconds(5, CONFINED),
      ],
      cautioned,
      5_000_000,
    );
    expect(shown.slice(1)).not.toContain(true);
  });

  it("is never the success colour while the warning holds, and is only ever on a connected tunnel", () => {
    expect(orbTone("connected", false)).toBe("success");
    expect(orbTone("connected", true)).toBe("caution");
    // Every other state keeps its own look, caution or not.
    const others: [ConnectionState, string][] = [
      ["degraded", "warning"],
      ["unverified", "highlight"],
      ["unknown", "muted"],
      ["disconnected", "idle"],
    ];
    for (const [state, tone] of others) {
      expect(orbTone(state, true), state).toBe(tone);
      expect(orbTone(state, false), state).toBe(tone);
    }
  });
});

describe("the dashboard and the orb use the rule", () => {
  const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
  const orb = readFileSync(new URL("../components/ConnectOrb.tsx", import.meta.url), "utf8");

  it("hands the orb the sustained caution, not the raw reading", () => {
    expect(dashboard).toMatch(/<ConnectOrb\s+state=\{connectionState\}\s+caution=\{cautionShown\}/);
    expect(dashboard).toContain("orbCaution.observe(");
    // The raw reading never reaches the orb.
    expect(dashboard).not.toMatch(/caution=\{ipv4NotConfined\}/);
  });

  it("colours the status dot by the same tone as the orb", () => {
    const dot = dashboard.slice(dashboard.indexOf('<div className="animate-rise flex items-center gap-2 text-xs text-muted-foreground">'));
    expect(dot.slice(0, 2_000)).toContain("orbTone(connectionState, cautionShown)");
  });

  it("takes its looks from the one rule", () => {
    expect(orb).toContain("orbTone(state, caution)");
    // The success rings are the success claim: not under the warning.
    expect(orb).toMatch(/const on = tone === "success";/);
  });

  it("keeps the headline's words immediate: honesty is not delayed with the colour", () => {
    expect(dashboard).toContain("unconfined: ipv4NotConfined");
  });
});
