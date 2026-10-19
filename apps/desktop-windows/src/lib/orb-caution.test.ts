import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ConnectionState } from "../components/ConnectOrb";
import {
  CAUTION_AFTER_MS,
  NO_CAUTION,
  NO_ORB_LOOK,
  nextCaution,
  nextOrbLook,
  orbTone,
  type CautionState,
  type HoldContext,
  type OrbLook,
  type OrbTone,
} from "./orb-caution";

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
  return playAt(
    looks.map((look, i): [Look, number] => [look, at + i * every]),
    from,
  );
}

/** The same, at the times given: the looks of a window whose timers are
 * throttled, or of a screen that came back. `tones` is what the orb drew. */
function playAt(looks: [Look, number][], from: CautionState = NO_CAUTION) {
  let state = from;
  const shown: boolean[] = [];
  const tones: OrbTone[] = [];
  for (const [look, at] of looks) {
    state = nextCaution(state, { byChoice: false, ...look }, at);
    shown.push(state.caution);
    tones.push(orbTone(look.state, state.caution));
  }
  return { state, shown, tones };
}

/** The tones drawn over a confirmed connection, in order. */
const connectedTones = (tones: OrbTone[]) => tones.filter((tone) => tone === "success" || tone === "caution");

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
    const { shown } = play([...seconds(3, CONFINED), ...seconds(13, UNCONFINED)]);
    const threshold = CAUTION_AFTER_MS / 1_000;
    // Let go of three seconds into the session: looks 3..3+threshold-1 are
    // inside its first ten seconds.
    expect(shown.slice(0, 3 + threshold)).toEqual(Array(3 + threshold).fill(false));
    expect(shown.slice(3 + threshold)).toEqual(Array(13 - threshold).fill(true));
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

  it("counts what was seen, not how often it was looked: a minimized window's minute-apart looks still count", () => {
    // WebView2 runs a minimized window's timers about once a minute (see
    // lib.rs). A confinement let go of while the app sits minimized is
    // seen at each of those looks, and nothing else is seen between them --
    // every change of what the service says is looked at as it lands. Each
    // look used to break "unbroken", so the window came back green and
    // turned amber ten seconds later, in front of the customer, over a
    // condition that had held all along.
    const t0 = 1_000_000;
    const looks: [Look, number][] = [
      [CONFINED, t0],
      [CONFINED, t0 + 1_000],
      [UNCONFINED, t0 + 60_000],
      [UNCONFINED, t0 + 120_000],
      [UNCONFINED, t0 + 180_000],
      // Restored: the tick is back to every second.
      ...Array.from({ length: 12 }, (_, i): [Look, number] => [UNCONFINED, t0 + 181_000 + i * 1_000]),
    ];
    const minimized = playAt(looks);
    expect(minimized.shown.slice(0, 3)).toEqual([false, false, false]);
    expect(minimized.shown.slice(3)).not.toContain(false);
    // So the window comes back in the colour it should have, and keeps it.
    expect(minimized.tones.slice(5)).toEqual(Array(12).fill("caution"));

    // And the other way: mended while minimized, it comes back green.
    const mended = playAt(
      [
        [CONFINED, t0 + 300_000],
        [CONFINED, t0 + 360_000],
        ...Array.from({ length: 5 }, (_, i): [Look, number] => [CONFINED, t0 + 361_000 + i * 1_000]),
      ],
      minimized.state,
    );
    expect(mended.shown.slice(1)).not.toContain(true);
  });

  it("never shows green over a warning because Settings was opened and closed", () => {
    // The dashboard unmounts while Settings is open. A remounted screen's
    // first look is its own starting state, "disconnected", before it has
    // asked the service anything. That used to wipe the per-app caution:
    // amber, then green for ten seconds, then amber -- from navigation
    // alone.
    const amber = play([...seconds(3, CONFINED), ...seconds(12, UNCONFINED)]);
    expect(amber.state.caution).toBe(true);
    const back = play([{ state: "disconnected", unconfined: false }, ...seconds(15, UNCONFINED)], amber.state, 2_000_000);
    expect(connectedTones(back.tones)).toEqual(Array(15).fill("caution"));

    // A screen that comes back to a session whose confinement went back in
    // meanwhile shows it green at once: no amber over what the service says
    // is confined.
    const mended = play([{ state: "disconnected", unconfined: false }, ...seconds(5, CONFINED)], amber.state, 3_000_000);
    expect(connectedTones(mended.tones)).toEqual(Array(5).fill("success"));
  });

  it("shows a session as the service says at its first confirmed look, either way", () => {
    // A switch -- another location, another protocol, a failover -- goes
    // from "connected" straight to "connecting", never "disconnected". The
    // warning of the session before used to carry into a fully confined
    // one for ten seconds, against a headline saying "You're protected".
    const amber = play([...seconds(3, CONFINED), ...seconds(12, UNCONFINED)]);
    const switched = play(
      [
        ...seconds(4, { state: "connecting", unconfined: true }),
        ...seconds(2, { state: "verifying", unconfined: false }),
        ...seconds(15, CONFINED),
      ],
      amber.state,
      2_000_000,
    );
    expect(connectedTones(switched.tones)).toEqual(Array(15).fill("success"));

    // And a session whose confinement would not go in at connect is not
    // fully protected from its first moment: a fact about the session, as
    // Built-in's is -- shown at once, not green and then amber.
    const failed = play([
      ...seconds(3, { state: "connecting", unconfined: false }),
      ...seconds(2, { state: "verifying", unconfined: true }),
      ...seconds(20, UNCONFINED),
    ]);
    expect(connectedTones(failed.tones)).toEqual(Array(20).fill("caution"));

    // The same for a screen that opens onto a session already up.
    const opened = play([{ state: "disconnected", unconfined: false }, ...seconds(12, UNCONFINED)]);
    expect(connectedTones(opened.tones)).toEqual(Array(12).fill("caution"));
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

describe("the orb's look over a short gap in a confirmed session", () => {
  /** What the orb is drawn as after each state, a second apart. */
  function held(states: ConnectionState[], from: OrbLook = NO_ORB_LOOK, at = 1_000_000) {
    let look = from;
    return states.map((state, i) => (look = nextOrbLook(look, state, at + i * 1_000)).state);
  }
  const n = (count: number, state: ConnectionState): ConnectionState[] => Array.from({ length: count }, () => state);
  const short = Math.floor(CAUTION_AFTER_MS / 1_000) - 1;

  it("keeps a confirmed session's look through one failed check, or a few", () => {
    for (const gap of ["degraded", "unverified", "unknown"] as ConnectionState[]) {
      const shown = held([...n(5, "connected"), ...n(short, gap), ...n(5, "connected")]);
      expect(shown.every((state) => state === "connected"), gap).toBe(true);
    }
    // Flipping between the up-but-unconfirmed states is one gap, not several.
    expect(held([...n(3, "connected"), "degraded", "unverified", "degraded", ...n(3, "connected")])).not.toContain("degraded");
  });

  it("shows the gap's own look once it has held, unbroken, and the connection's again once confirmed", () => {
    // Held for the looks at 0 to 9 s into the gap; its own look from 10 s.
    const full = CAUTION_AFTER_MS / 1_000;
    const shown = held([...n(3, "connected"), ...n(full + 3, "degraded"), "connected"]);
    expect(shown.slice(0, 3 + full)).not.toContain("degraded");
    expect(shown.slice(3 + full, -1)).toEqual(n(3, "degraded"));
    expect(shown[shown.length - 1]).toBe("connected");
  });

  it("never holds a look the session has not had: a first look, or one after a connect, is shown as it is", () => {
    expect(held(["unverified", "unverified"])).toEqual(["unverified", "unverified"]);
    expect(held(["connecting", "verifying", "degraded"])).toEqual(["connecting", "verifying", "degraded"]);
    // A drop with no reconnect to follow is not a gap to hold over: "VPN
    // connection lost" is said, and coloured, at once.
    expect(held(["connected", "disconnected", "connecting"])).toEqual(["connected", "disconnected", "connecting"]);
  });
});

/** Decision 2 of the redesign (owner, 2026-10-19): the calm hold covers
 * reconnect episodes too, the connect control's fill included. A reconnect
 * nobody pressed for keeps the session's settled look -- cobalt from a
 * verified session, teal from a "not confirmed" one -- for up to
 * CAUTION_AFTER_MS, and then shows its own. Anything the customer presses
 * shows at once. The words are not this file's and change at once. */
describe("the look over a reconnect nobody pressed for", () => {
  type Step = [ConnectionState, HoldContext?];
  /** The looks drawn, one second apart, and the tone the chip would take. */
  function playHold(steps: Step[], from: OrbLook = NO_ORB_LOOK, at = 1_000_000) {
    let look = from;
    const states: ConnectionState[] = [];
    const tones: OrbTone[] = [];
    steps.forEach(([state, context], i) => {
      look = nextOrbLook(look, state, at + i * 1_000, context);
      states.push(look.state);
      tones.push(orbTone(look.state, look.caution));
    });
    return { states, tones, look };
  }
  const n = (count: number, step: Step): Step[] => Array.from({ length: count }, () => step);
  const RECONNECTING: HoldContext = { reconnecting: true };
  const threshold = CAUTION_AFTER_MS / 1_000;

  it("keeps a verified session's cobalt through a five-second reconnect", () => {
    const { tones } = playHold([
      ...n(5, ["connected"]),
      ["disconnected", RECONNECTING],
      ...n(3, ["connecting", RECONNECTING]),
      ["verifying", RECONNECTING],
      ...n(5, ["connected"]),
    ]);
    expect(tones).toEqual(Array(tones.length).fill("success"));
  });

  it("keeps a not-confirmed session's teal through one, not promoting it to cobalt", () => {
    const { tones } = playHold([
      ...n(4, ["unverified"]),
      ["disconnected", RECONNECTING],
      ...n(3, ["connecting", RECONNECTING]),
      ...n(2, ["unverified"]),
    ]);
    expect(tones).toEqual(Array(tones.length).fill("highlight"));
  });

  it("shows the reconnect's own look once it has held, unbroken, for the threshold", () => {
    const { states } = playHold([
      ...n(3, ["connected"]),
      ["disconnected", RECONNECTING],
      ...n(threshold + 3, ["connecting", RECONNECTING]),
      ["connected"],
    ]);
    // Held for the looks at 0 to threshold-1 seconds into the episode.
    expect(states.slice(0, 3 + threshold)).toEqual(Array(3 + threshold).fill("connected"));
    expect(states.slice(3 + threshold, -1)).toEqual(Array(4).fill("connecting"));
    expect(states[states.length - 1]).toBe("connected");
  });

  it("holds through the health poll's own failover, which nobody pressed for either", () => {
    const { states } = playHold([...n(3, ["connected"]), ...n(2, ["degraded"]), ...n(4, ["connecting"]), ["connected"]]);
    expect(states).toEqual(Array(states.length).fill("connected"));
  });

  it("shows anything the customer presses at once", () => {
    const pressed: HoldContext = { pressed: true };
    expect(playHold([...n(3, ["connected"]), ["disconnecting", pressed], ["disconnected", pressed]]).states).toEqual([
      "connected",
      "connected",
      "connected",
      "disconnecting",
      "disconnected",
    ]);
    // "Reconnect now" in the middle of an episode is the customer's own
    // connect: its busy look at once.
    const { states } = playHold([...n(3, ["connected"]), ["disconnected", RECONNECTING], ["connecting", pressed]]);
    expect(states.slice(-2)).toEqual(["connected", "connecting"]);
    expect(orbTone("connecting", false)).toBe("busy");
  });

  it("keeps the warning colour of a session that was not fully protected, rather than showing it cobalt", () => {
    const amber: HoldContext = { caution: true };
    const { tones } = playHold([
      ...n(4, ["connected", amber]),
      ["disconnected", { ...RECONNECTING, caution: false }],
      ...n(3, ["connecting", { ...RECONNECTING, caution: false }]),
    ]);
    expect(tones).toEqual(Array(tones.length).fill("caution"));
  });

  it("starts at the idle look, so nothing is drawn cobalt before a verified state arrives", () => {
    expect(NO_ORB_LOOK.state).toBe("disconnected");
    expect(orbTone(NO_ORB_LOOK.state, NO_ORB_LOOK.caution)).toBe("idle");
    // And a pass on a fresh screen is not held as anything.
    expect(playHold([["connecting"], ["verifying"]]).states).toEqual(["connecting", "verifying"]);
  });
});

describe("the dashboard and the orb use the rule", () => {
  const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
  const orb = readFileSync(new URL("../components/ConnectOrb.tsx", import.meta.url), "utf8");

  it("hands the orb the sustained caution, not the raw reading", () => {
    expect(dashboard).toMatch(/<ConnectOrb\s+state=\{orbState\}\s+caution=\{cautionShown\}/);
    expect(dashboard).toContain("orbHold.observe(");
    expect(dashboard).toContain("orbCaution.observe(");
    // The raw reading never reaches the orb.
    expect(dashboard).not.toMatch(/caution=\{ipv4NotConfined\}/);
  });

  it("colours the status dot by the same tone as the orb", () => {
    const dot = dashboard.slice(dashboard.indexOf('<div className="animate-rise flex items-center gap-2 text-xs text-muted-foreground">'));
    expect(dot.slice(0, 2_000)).toContain("orbTone(orbState, cautionShown)");
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
