import { afterEach, describe, expect, it, vi } from "vitest";

/** The health poll's ceiling.
 *
 * Measured on the emulator on 2026-11-17, on 0.2.41 and the DNS branch
 * alike: with every packet to the server dropped, the phone said "You're
 * protected" for about 185 s. The poll asked the baseline's endpoint, then
 * walked the whole list -- about twenty endpoints -- one after another
 * with no ceiling, six seconds each.
 *
 * Only the transport is stood in for. Addresses are RFC 5737 stand-ins. */

let endpoints: string[] = [];
vi.mock("@shared/lib/api-endpoints", () => ({ apiEndpoints: async () => endpoints }));
vi.mock("@shared/lib/network-identity", () => ({ rememberNetwork: () => undefined }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("not registered")) }));
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: () => Promise.reject(new Error("the installed transport is the one under test")),
}));

const { EGRESS_TIMEOUT_MS, setHealthIpTransport, verifyEgress } = await import("@shared/lib/egress");
const { POLL_OWN_MS, POLL_WALK_MS, pollEgress, pollState, singleFlight } = await import("./tunnel-evidence");

const PHONE = "192.0.2.44";
const EXIT = "203.0.113.41";
const EDGE = "198.51.100.10";
const LIST = Array.from({ length: 20 }, (_, i) => `https://e${i}.example.test/api`);

const net = {
  /** Through the tunnel nothing answers: every request waits out its timeout. */
  dead: false,
  /** Up, but leaving on the bare line: every endpoint sees the phone. */
  leaking: false,
  /** Endpoints that do not answer through the tunnel. */
  silent: new Set<string>(),
};

setHealthIpTransport(async (base, timeoutMs) => {
  if (net.dead || net.silent.has(base)) {
    await new Promise((r) => setTimeout(r, timeoutMs));
    throw new Error("timed out");
  }
  return { status: 200, body: { ip: net.leaking ? PHONE : EXIT }, peer: EDGE };
});

/** How long `promise` took on the fake clock, advancing it a second at a time. */
async function timed<T>(promise: Promise<T>, ceilingMs: number): Promise<{ value: T; ms: number }> {
  let value: T | undefined;
  let done = false;
  void promise.then((v) => {
    value = v;
    done = true;
  });
  const start = Date.now();
  while (!done && Date.now() - start < ceilingMs) await vi.advanceTimersByTimeAsync(1_000);
  if (!done) throw new Error(`still running after ${ceilingMs} ms`);
  return { value: value as T, ms: Date.now() - start };
}

afterEach(() => {
  vi.useRealTimers();
  endpoints = [];
  net.dead = false;
  net.leaking = false;
  net.silent.clear();
});

describe("a dead tunnel", () => {
  it("took minutes to be noticed by an unbounded walk", async () => {
    // The control: the poll's second step as it was.
    vi.useFakeTimers();
    endpoints = LIST;
    net.dead = true;
    const baseline = { ip: PHONE, from: LIST[0], peer: EDGE };
    const { value, ms } = await timed(verifyEgress(baseline, {}), 200_000);
    expect(value.state).toBe("unreachable");
    expect(ms).toBeGreaterThanOrEqual(LIST.length * EGRESS_TIMEOUT_MS);
  });

  it("is reported by one poll within its ceiling", async () => {
    vi.useFakeTimers();
    endpoints = LIST;
    net.dead = true;
    const baseline = { ip: PHONE, from: LIST[3], peer: EDGE };
    const { value, ms } = await timed(pollEgress(baseline), 60_000);
    expect(value.state).toBe("unreachable");
    // The baseline's endpoint, the walk, and the second look.
    expect(ms).toBeLessThanOrEqual(POLL_OWN_MS + 2 * POLL_WALK_MS + 3_000);
    expect(pollState("connected", value)).toBe("degraded");
  });

  it("is reported within the ceiling with no baseline at all", async () => {
    vi.useFakeTimers();
    endpoints = LIST;
    net.dead = true;
    const { value, ms } = await timed(pollEgress(null), 60_000);
    expect(value.state).toBe("unreachable");
    expect(ms).toBeLessThanOrEqual(2 * POLL_WALK_MS + 3_000);
  });
});

describe("a working tunnel on a network that blocks endpoints", () => {
  it("is not accused when the baseline's endpoint and the first two of the list stop answering", async () => {
    vi.useFakeTimers();
    endpoints = LIST;
    const baseline = { ip: PHONE, from: LIST[5], peer: EDGE };
    net.silent.add(LIST[5]).add(LIST[0]).add(LIST[1]);
    const { value } = await timed(pollEgress(baseline), 60_000);
    // Another endpoint answered: no comparison, never "not carrying".
    expect(value.state).toBe("indeterminate");
    expect(pollState("connected", value)).toBe("connected");
    expect(pollState("unverified", value)).toBe("unverified");
  });

  it("stays confirmed when the baseline's endpoint answers, however many others are silent", async () => {
    vi.useFakeTimers();
    endpoints = LIST;
    for (const base of LIST.slice(0, 5)) net.silent.add(base);
    const baseline = { ip: PHONE, from: LIST[7], peer: EDGE };
    const { value } = await timed(pollEgress(baseline), 60_000);
    expect(value).toMatchObject({ state: "throughTunnel", exitIp: EXIT });
    expect(pollState("unverified", value)).toBe("connected");
  });

  it("is not accused when only the last endpoint of a mostly blocked list answers", async () => {
    // Hedged, a second apart: every endpoint is asked inside the ceiling.
    vi.useFakeTimers();
    endpoints = LIST.slice(0, 8);
    const baseline = { ip: PHONE, from: LIST[0], peer: EDGE };
    for (const base of LIST.slice(0, 7)) net.silent.add(base);
    const { value } = await timed(pollEgress(baseline), 60_000);
    expect(value.state).toBe("indeterminate");
  });
});

describe("a leaking tunnel", () => {
  it("is still caught", async () => {
    endpoints = LIST;
    net.leaking = true;
    const baseline = { ip: PHONE, from: LIST[2], peer: EDGE };
    const value = await pollEgress(baseline);
    expect(value).toMatchObject({ state: "bypassingTunnel", exitIp: PHONE });
    expect(pollState("connected", value)).toBe("degraded");
  });
});

describe("the poll", () => {
  it("never runs twice at once", async () => {
    let running = 0;
    let most = 0;
    let runs = 0;
    let release: () => void = () => undefined;
    const poll = singleFlight(async () => {
      runs += 1;
      running += 1;
      most = Math.max(most, running);
      await new Promise<void>((r) => (release = r));
      running -= 1;
    });
    const first = poll();
    // The interval fires again while the first is still waiting.
    await poll();
    await poll();
    expect(runs).toBe(1);
    release();
    await first;
    // Free again once it has finished.
    const second = poll();
    release();
    await second;
    expect(runs).toBe(2);
    expect(most).toBe(1);
  });

  it("is the dashboard's", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
    expect(source).toContain("const check = singleFlight(checkOnce);");
    expect(source).toContain("pollEgress(baselineIp, tunnelServerRef.current ?? undefined)");
  });
});

describe("one silent poll", () => {
  // Nothing answering for one walk can happen on a congested line that
  // works. The whole list is asked again at once, and only a second
  // silence is "not carrying traffic".
  it("is looked at again at once, and a working tunnel stays", async () => {
    vi.useFakeTimers();
    endpoints = LIST.slice(0, 5);
    net.dead = true;
    const baseline = { ip: PHONE, from: LIST[0], peer: EDGE };
    let value: Awaited<ReturnType<typeof pollEgress>> | undefined;
    void pollEgress(baseline).then((v) => (value = v));
    // Past the baseline's endpoint and the first walk...
    await vi.advanceTimersByTimeAsync(POLL_OWN_MS + POLL_WALK_MS + 1_500);
    expect(value).toBeUndefined();
    // ...the line clears, and the second look finds the tunnel.
    net.dead = false;
    await vi.advanceTimersByTimeAsync(POLL_WALK_MS + 2_000);
    // Answered -- by whichever endpoint answered first -- so not accused.
    expect(value).toBeDefined();
    expect(value!.state).not.toBe("unreachable");
    expect(pollState("connected", value!)).toBe("connected");
  });

  it("puts a really dead tunnel within about 40 s of dying", () => {
    // Died just after a poll: the next one in 15 s, then the baseline's
    // endpoint (6 s, and the transport's 1 s backstop), the walk (8 s), the
    // second look (8 s), a second each for the walks' last requests.
    const worst = 15_000 + POLL_OWN_MS + 1_000 + 2 * (POLL_WALK_MS + 1_000);
    expect(worst).toBeLessThanOrEqual(45_000);
  });
});
