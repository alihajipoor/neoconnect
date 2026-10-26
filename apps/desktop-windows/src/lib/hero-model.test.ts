import { describe, expect, it } from "vitest";
import type { ConnectionState } from "../components/ConnectOrb";
import { headlineFor } from "./connection-evidence";
import { pressFor } from "./connect-intent";
import {
  announcedAtOnce,
  announcedOnSettle,
  chipFor,
  hintTone,
  ipFor,
  lineFor,
  pillFor,
  planCaution,
  secondaryFor,
  SETTLE_MS,
  shownTone,
} from "./hero-model";
import { DICTIONARIES } from "./i18n";
import { orbTone } from "./orb-caution";

/** Every row of the state table in design-system.md, section 4.3: what the
 * chip, the line, the pill and the way out say for each state, taken
 * through the same tables the Dashboard uses (`headlineFor`, `pressFor`). */

type Row = {
  name: string;
  state: ConnectionState;
  dropped?: boolean;
  reconnecting?: { waiting: boolean; offline: boolean } | null;
  unconfined?: boolean;
  waitingForNetwork?: boolean;
  pressed?: boolean;
  failed?: boolean;
  connectedAt?: number | null;
  chip: [string, string];
  line: string;
  pill: string;
  variant: string;
  secondary: string | null;
};

const ROWS: Row[] = [
  { name: "disconnected", state: "disconnected", chip: ["chip.idle", "idle"], line: "dash.notProtected", pill: "btn.connect", variant: "primary", secondary: null },
  { name: "connecting (pressed)", state: "connecting", pressed: true, chip: ["chip.connecting", "spin"], line: "dash.verifying", pill: "btn.connecting", variant: "busy", secondary: "stopConnecting" },
  { name: "verifying (pressed)", state: "verifying", pressed: true, chip: ["chip.verifying", "spin"], line: "dash.verifying", pill: "btn.checking", variant: "busy", secondary: "stopConnecting" },
  { name: "connected, timed", state: "connected", connectedAt: 1, chip: ["chip.connected", "check"], line: "timer", pill: "btn.disconnect", variant: "primary", secondary: null },
  { name: "connected, adopted at launch", state: "connected", connectedAt: null, chip: ["chip.connected", "check"], line: "dash.protected", pill: "btn.disconnect", variant: "primary", secondary: null },
  { name: "not confined", state: "connected", unconfined: true, connectedAt: 1, chip: ["chip.unconfined", "diamond"], line: "timer", pill: "btn.disconnect", variant: "primary", secondary: null },
  { name: "unverified", state: "unverified", chip: ["chip.unverified", "ring"], line: "dash.unverified", pill: "btn.disconnect", variant: "primary", secondary: null },
  { name: "degraded", state: "degraded", chip: ["chip.degraded", "dot"], line: "dash.degraded", pill: "btn.disconnect", variant: "primary", secondary: null },
  { name: "reconnecting, between attempts", state: "disconnected", dropped: true, reconnecting: { waiting: true, offline: false }, chip: ["chip.reconnecting", "spin"], line: "dash.reconnecting", pill: "dash.reconnectNow", variant: "primary", secondary: "stopReconnecting" },
  { name: "reconnecting, attempting", state: "connecting", dropped: true, reconnecting: { waiting: false, offline: false }, chip: ["chip.reconnecting", "spin"], line: "dash.reconnecting", pill: "btn.connecting", variant: "primary-busy", secondary: "stopReconnecting" },
  { name: "waiting for network", state: "connecting", waitingForNetwork: true, pressed: true, chip: ["chip.noNetwork", "dash"], line: "dash.waitingForNetwork", pill: "btn.waiting", variant: "busy", secondary: "stopConnecting" },
  { name: "unknown", state: "unknown", chip: ["chip.unknown", "dash"], line: "dash.unknown", pill: "btn.recheck", variant: "primary", secondary: null },
  { name: "disconnecting", state: "disconnecting", pressed: true, chip: ["chip.disconnecting", "spin"], line: "dash.notProtected", pill: "btn.disconnecting", variant: "busy", secondary: null },
  { name: "dropped", state: "disconnected", dropped: true, chip: ["chip.dropped", "dot"], line: "dash.dropped", pill: "btn.connect", variant: "primary", secondary: null },
  { name: "connect failed", state: "disconnected", failed: true, chip: ["chip.idle", "idle"], line: "dash.notProtected", pill: "btn.tryAgain", variant: "primary", secondary: "tryAnother" },
];

describe("the hero, state by state", () => {
  it.each(ROWS)("$name", (row) => {
    const reconnecting = row.reconnecting ?? null;
    const headline = headlineFor(row.state, {
      dropped: row.dropped ?? false,
      customMode: false,
      reconnecting,
      unconfined: row.unconfined ?? false,
      waitingForNetwork: row.waitingForNetwork ?? false,
    });
    const press = pressFor(row.state, { reconnectWaiting: row.reconnecting?.waiting === true });
    const chip = chipFor(row.state, headline);
    expect([chip.labelKey, chip.glyph]).toEqual(row.chip);
    const line = lineFor(row.state, headline, { connectedAt: row.connectedAt ?? null });
    expect(line.kind === "timer" ? "timer" : line.key).toBe(row.line);
    const pill = pillFor(row.state, press, {
      pressed: row.pressed ?? false,
      waitingForNetwork: row.waitingForNetwork,
      failed: row.failed,
    });
    expect(pill.labelKey).toBe(row.pill);
    expect(pill.variant).toBe(row.variant);
    expect(secondaryFor(press, { reconnecting: reconnecting !== null, failed: row.failed ?? false })).toBe(row.secondary);
    // Every key named here exists in both languages.
    for (const key of [chip.labelKey, pill.labelKey, line.kind === "words" ? line.key : "chip.connected"]) {
      expect(DICTIONARIES.en[key], key).toBeTruthy();
      expect(DICTIONARIES.fa[key], key).toBeTruthy();
    }
  });

  it("never shows the check glyph or the timer for anything but a verified tunnel", () => {
    for (const state of ["disconnected", "connecting", "verifying", "unverified", "degraded", "unknown", "disconnecting"] as ConnectionState[]) {
      const headline = headlineFor(state, { dropped: false, customMode: false });
      expect(chipFor(state, headline).glyph, state).not.toBe("check");
      expect(lineFor(state, headline, { connectedAt: 1 }).kind, state).toBe("words");
    }
  });

  it("says the device limit's teardown as a disconnect while it runs", () => {
    const headline = headlineFor("disconnecting", { dropped: false, customMode: false });
    expect(chipFor("disconnecting", headline, { teardownShowing: true }).labelKey).toBe("chip.disconnecting");
    expect(lineFor("connected", headline, { connectedAt: 1, teardownShowing: true })).toEqual({ kind: "words", key: "dash.disconnecting" });
  });
});

describe("the calm tone the screen wears", () => {
  it("follows the held look, and only names a reconnect once it has outlasted the hold", () => {
    // Held: the orb is still drawn connected, so the screen stays cobalt.
    expect(shownTone(orbTone("connected", false), { reconnecting: true, dropped: true })).toBe("ok");
    // Past the hold, the reconnect's own look is a sustained, real gap.
    expect(shownTone(orbTone("connecting", false), { reconnecting: true, dropped: true })).toBe("warn");
    expect(shownTone(orbTone("disconnected", false), { reconnecting: true, dropped: true })).toBe("warn");
  });

  it("is neutral for a busy somebody pressed for, and for a fresh screen", () => {
    expect(shownTone(orbTone("connecting", false), { reconnecting: false, dropped: false })).toBe("idle");
    expect(shownTone(orbTone("disconnected", false), { reconnecting: false, dropped: false })).toBe("idle");
  });

  it("is the danger tone only for a tunnel that closed with nobody asking, and no reconnect", () => {
    expect(shownTone(orbTone("disconnected", false), { reconnecting: false, dropped: true })).toBe("danger");
  });

  it("maps every other look one to one", () => {
    expect(shownTone("caution", { reconnecting: false, dropped: false })).toBe("caution");
    expect(shownTone("warning", { reconnecting: false, dropped: false })).toBe("warn");
    expect(shownTone("highlight", { reconnecting: false, dropped: false })).toBe("hl");
    expect(shownTone("muted", { reconnecting: false, dropped: false })).toBe("muted");
  });

  it("colours the sentence only for a sustained problem, or a failed connect", () => {
    expect(hintTone("ok")).toBeNull();
    expect(hintTone("idle")).toBeNull();
    expect(hintTone("warn")).toBe("warn");
    expect(hintTone("danger")).toBe("danger");
    expect(hintTone("idle", { failed: true })).toBe("caution");
  });
});

// The VM, 2026-10-20 (round 2): the screen reader's live region still held
// "Not carrying traffic. ...Your traffic is NOT protected" 0.8 s into a hold
// that had made it false, while the screen said "Checking connection...".
describe("the screen reader's region", () => {
  const DEGRADED = "Not carrying traffic. The tunnel is up but the server isn't responding. Your traffic is NOT protected.";
  const CHECKING = "Checking connection.... Other connections on this computer are blocked until Neoxify reconnects, as you set.";

  it("lets go of what it said the moment the words change; the new ones wait to settle", () => {
    expect(announcedAtOnce(DEGRADED, CHECKING)).toBe("");
    expect(announcedAtOnce("", CHECKING)).toBe("");
  });

  it("keeps what it says while the words stay the same", () => {
    expect(announcedAtOnce(CHECKING, CHECKING)).toBe(CHECKING);
  });

  /** Plays the state's words through the region as `StateAnnouncer` does --
   * each change at its time (ms), emptied at once, the words given once they
   * have stood `SETTLE_MS` -- and returns every addition to the region: what
   * a screen reader says. */
  function spoken(changes: [number, string][]): string[] {
    let said = "";
    let last = "";
    const added: string[] = [];
    let settling: { at: number; text: string } | null = null;
    const end = changes[changes.length - 1][0] + SETTLE_MS + 1;
    for (let now = 0; now <= end; now += 1) {
      if (settling !== null && now >= settling.at) {
        const next = announcedOnSettle(last, settling.text);
        if (next !== null) {
          last = next;
          if (said !== next) added.push(next);
          said = next;
        }
        settling = null;
      }
      const change = changes.find(([at]) => at === now);
      if (change !== undefined) {
        said = announcedAtOnce(said, change[1]);
        settling = { at: now + SETTLE_MS, text: change[1] };
      }
    }
    return added;
  }

  // 2026-10-25 review: emptying the region at once made a blip shorter
  // than SETTLE_MS speak the unchanged state again: "" to the same words is
  // a new addition. Before, such a blip was silent.
  it("does not say the same state again after a blip shorter than the settle time", () => {
    expect(spoken([[0, CHECKING], [2_000, DEGRADED], [2_000 + SETTLE_MS - 100, CHECKING]])).toEqual([CHECKING]);
    // A change that settles is said, and so is the way back.
    expect(spoken([[0, CHECKING], [2_000, DEGRADED], [2_000 + SETTLE_MS + 100, CHECKING]])).toEqual([CHECKING, DEGRADED, CHECKING]);
    // And after a blip, the next real change.
    expect(spoken([[0, CHECKING], [2_000, DEGRADED], [2_300, CHECKING], [5_000, DEGRADED]])).toEqual([CHECKING, DEGRADED]);
    expect(announcedOnSettle(CHECKING, CHECKING)).toBeNull();
    expect(announcedOnSettle(CHECKING, DEGRADED)).toBe(DEGRADED);
  });
});

describe("the tray", () => {
  it("shows the address only for a verified tunnel, and never in gaming mode", () => {
    expect(ipFor("connected", "203.0.113.7", { gaming: false })).toEqual({ kind: "ip", ip: "203.0.113.7" });
    expect(ipFor("connected", "203.0.113.7", { gaming: true })).toEqual({ kind: "words", key: "tr.ipGaming" });
    expect(ipFor("unverified", "203.0.113.7", { gaming: false })).toEqual({ kind: "words", key: "tr.ipPending" });
    expect(ipFor("degraded", null, { gaming: false })).toEqual({ kind: "words", key: "tr.ipPending" });
    expect(ipFor("disconnected", "203.0.113.7", { gaming: false })).toEqual({ kind: "words", key: "tr.ipOff" });
    expect(ipFor("unknown", null, { gaming: false })).toEqual({ kind: "none" });
  });

  it("turns the plan caution only for nine tenths used, or three days left", () => {
    expect(planCaution(0.89, 4)).toEqual({ meter: false, days: false });
    expect(planCaution(0.9, 3)).toEqual({ meter: true, days: true });
    expect(planCaution(null, null)).toEqual({ meter: false, days: false });
  });
});
