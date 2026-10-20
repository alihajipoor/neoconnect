import { describe, expect, it } from "vitest";
import { FRESH_MEMORY, NOTIFY_TEXT, notifyStep, type NotifyInput, type NotifyKind, type NotifyMemory } from "./connection-notify";
import type { ShownTone } from "./hero-model";
import { DICTIONARIES } from "./i18n";

/** Plays a sequence of looks at the screen's calm tone, as the main page
 * makes them, and collects what would have been said. */
function play(looks: Partial<NotifyInput & { tone: ShownTone }>[], memory: NotifyMemory = FRESH_MEMORY): (NotifyKind | null)[] {
  const said: (NotifyKind | null)[] = [];
  let m = memory;
  for (const look of looks) {
    const step = notifyStep(m, { tone: "idle", reconnecting: false, holding: false, focused: false, gaming: false, ...look });
    m = step.memory;
    said.push(step.say);
  }
  return said;
}

describe("what is worth a notification", () => {
  it("says connected once, when a tunnel is verified from nothing", () => {
    expect(play([{ tone: "idle" }, { tone: "ok" }, { tone: "ok" }])).toEqual([null, "connected", null]);
  });

  it("says so in other words when not every connection is held to the tunnel", () => {
    expect(play([{ tone: "caution" }])).toEqual(["connectedPartial"]);
  });

  it("says nothing for a gap inside the calm hold: the tone never moved", () => {
    // A reconnect, a rung, an engine restarted -- the held tone stays ok.
    expect(play([{ tone: "ok" }, { tone: "ok", reconnecting: true }, { tone: "ok", reconnecting: true }, { tone: "ok" }])).toEqual([
      "connected",
      null,
      null,
      null,
    ]);
  });

  it("says the connection is lost once the reconnect outlasts the hold, then that it is back", () => {
    expect(
      play([{ tone: "ok" }, { tone: "warn", reconnecting: true }, { tone: "warn", reconnecting: true }, { tone: "ok" }]),
    ).toEqual(["connected", "lost", null, "back"]);
  });

  it("says the internet is blocked meanwhile when the service is holding it", () => {
    expect(play([{ tone: "ok" }, { tone: "warn", reconnecting: true, holding: true }])).toEqual(["connected", "lostHeld"]);
  });

  it("says it is gone when nothing is reconnecting it", () => {
    expect(play([{ tone: "ok" }, { tone: "warn", reconnecting: true }, { tone: "danger" }])).toEqual(["connected", "lost", "dropped"]);
    expect(play([{ tone: "ok" }, { tone: "danger" }])).toEqual(["connected", "dropped"]);
  });

  it("says nothing about the customer's own Disconnect", () => {
    expect(play([{ tone: "ok" }, { tone: "idle" }, { tone: "idle" }])).toEqual(["connected", null, null]);
    // And a Disconnect forgets the session: a later drop of nothing is silent.
    expect(play([{ tone: "ok" }, { tone: "idle" }, { tone: "danger" }])).toEqual(["connected", null, null]);
  });

  it("does not take a degraded tunnel's amber for a loss: the failover is fixing it", () => {
    expect(play([{ tone: "ok" }, { tone: "warn", reconnecting: false }])).toEqual(["connected", null]);
  });

  it("says nothing about a state the app has not measured", () => {
    expect(play([{ tone: "ok" }, { tone: "hl" }, { tone: "muted" }])).toEqual(["connected", null, null]);
  });

  it("says nothing while the window is in front, and does not repeat what was seen there", () => {
    // Seen on screen: nothing said. Back while still in front: nothing.
    expect(play([{ tone: "ok", focused: true }, { tone: "warn", reconnecting: true, focused: true }, { tone: "ok", focused: true }])).toEqual([
      null,
      null,
      null,
    ]);
    // A loss seen on screen, and back after looking away: that is news.
    expect(play([{ tone: "ok", focused: true }, { tone: "warn", reconnecting: true, focused: true }, { tone: "ok", focused: false }])).toEqual([
      null,
      null,
      "back",
    ]);
  });

  it("says nothing in Gaming mode, which has no tunnel", () => {
    expect(play([{ tone: "ok", gaming: true }, { tone: "danger", gaming: true }])).toEqual([null, null]);
  });
});

describe("the words", () => {
  const { en, fa } = DICTIONARIES;

  it("exist in both languages for every kind", () => {
    for (const { title, body } of Object.values(NOTIFY_TEXT)) {
      expect(en[title] && fa[title], title).toBeTruthy();
      expect(en[body] && fa[body], body).toBeTruthy();
    }
  });

  it("say traffic is not protected while it is lost, and never claim protection", () => {
    for (const key of ["notif.lostBody", "notif.droppedBody"] as const) {
      expect(en[key], key).toMatch(/not protected/);
      expect(fa[key], key).toContain("محافظت نمی‌شود");
    }
    for (const kind of Object.values(NOTIFY_TEXT)) {
      for (const key of [kind.title, kind.body]) {
        expect(en[key], key).not.toMatch(/you're protected|you are protected|\bsecure\b|\bsafe\b/i);
      }
    }
  });

  it("say what was checked when they say it is connected", () => {
    expect(en["notif.connectedBody"]).toMatch(/checked/);
    expect(en["notif.backBody"]).toMatch(/checked/);
    expect(fa["notif.connectedBody"]).toContain("بررسی کرد");
    // Not every connection held: said, not smoothed over.
    expect(en["notif.connectedPartialBody"]).toMatch(/not every connection/);
  });

  it("say the internet is blocked only for the hold, as the customer set it", () => {
    expect(en["notif.lostHeldBody"]).toMatch(/blocked/);
    expect(en["notif.lostHeldBody"]).toMatch(/as you set/);
    expect(fa["notif.lostHeldBody"]).toContain("مسدود");
  });
});
