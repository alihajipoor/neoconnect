import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: () => Promise.reject(new Error("no store")) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("test") }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: () => Promise.reject(new Error("no network")) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("no tauri")) }));

const { createSessionTracker, SESSION_END_MIN_MS, SUSTAINED_MS } = await import("./session-report");
import type { AttemptReport } from "./attempts";

/** The end of a session (`SessionTracker.ended`): one report, for a
 * session of at least a minute, with why it ended and how long it ran --
 * from the live tracker, never from the local session log. */

function tracked() {
  let clock = 1_000_000;
  const sent: AttemptReport[] = [];
  const tracker = createSessionTracker(async (r) => void sent.push(r), () => clock);
  return {
    tracker,
    sent,
    ends: () => sent.filter((r) => r.details?.sessionEnd),
    advance: (ms: number) => (clock += ms),
  };
}

describe("a session's end report", () => {
  it("is sent for a session of a minute or more, with its cause and length", () => {
    const { tracker, ends, advance } = tracked();
    tracker.healthy("r1", "Stealth");
    advance(SESSION_END_MIN_MS + 5_000);
    tracker.ended("disconnected");
    expect(ends()).toEqual([
      {
        kind: "SESSION",
        outcome: "OTHER",
        routeId: "r1",
        protocol: "Stealth",
        reason: "session ended (disconnected) after 65 s; not an attempt",
        details: { sessionEnd: { cause: "disconnected", seconds: 65 } },
      },
    ]);
    // Never read as ten minutes of health by the server.
    expect(ends()[0].sessionSeconds).toBeUndefined();
  });

  it("is not sent for a shorter session", () => {
    const { tracker, ends, advance } = tracked();
    tracker.healthy("r1");
    advance(SESSION_END_MIN_MS - 1);
    tracker.ended("lost");
    expect(ends()).toEqual([]);
  });

  it("is sent once, however many times the end is said", () => {
    const { tracker, ends, advance } = tracked();
    tracker.healthy("r1");
    advance(2 * SESSION_END_MIN_MS);
    tracker.ended("lost");
    tracker.ended("disconnected");
    tracker.broken();
    expect(ends()).toHaveLength(1);
    expect(ends()[0].details?.sessionEnd?.cause).toBe("lost");
  });

  it("counts from the first passing check through failed ones: a failed check is not an end", () => {
    const { tracker, ends, advance } = tracked();
    tracker.healthy("r1");
    advance(30_000);
    tracker.broken();
    advance(30_000);
    tracker.healthy("r1");
    advance(30_000);
    tracker.ended("lost");
    expect(ends()[0].details?.sessionEnd).toEqual({ cause: "lost", seconds: 90 });
  });

  it("names a server switch as replaced", () => {
    const { tracker, ends, advance } = tracked();
    tracker.healthy("r1");
    advance(SESSION_END_MIN_MS);
    tracker.healthy("r2");
    expect(ends()).toHaveLength(1);
    expect(ends()[0]).toMatchObject({ routeId: "r1", details: { sessionEnd: { cause: "replaced", seconds: 60 } } });
  });

  it("leaves the ten-minute report as it was", () => {
    const { tracker, sent, advance } = tracked();
    tracker.healthy("r1", "Stealth");
    advance(SUSTAINED_MS);
    tracker.healthy("r1", "Stealth");
    expect(sent).toEqual([
      { kind: "SESSION", outcome: "SUCCESS", routeId: "r1", protocol: "Stealth", sessionSeconds: SUSTAINED_MS / 1000 },
    ]);
  });

  it("is nothing without a session", () => {
    const { tracker, sent } = tracked();
    tracker.ended("disconnected");
    expect(sent).toEqual([]);
  });
});
