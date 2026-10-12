import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BLOCKED_WAIT_MAX_MS } from "./auto-reconnect";
import {
  NETWORK_POLL_MS,
  NETWORK_RETRY_ANYWAY_MS,
  NETWORK_WAIT_MAX_MS,
  networkWait,
  waitForNetwork,
  type NetworkWaitDeps,
} from "./network-wait";

/** A connect the service refused for want of a network -- every engine
 * fails at once with no network (1ff7dbc) -- used to count as a rung that
 * failed: the ladder went on to the next server, and the automatic
 * reconnect spent its six attempts in about a minute and landed the
 * customer in another country (G8, g8-01: fi to sg). Now the pass waits,
 * on the same rung, until there is a network again. */

function clock({ backAt = Infinity, stopAt = Infinity }: { backAt?: number; stopAt?: number } = {}) {
  let now = 0;
  const asked: number[] = [];
  let progress = 0;
  const deps: NetworkWaitDeps = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    wayOut: async () => {
      asked.push(now);
      return now >= backAt;
    },
    stopped: () => now >= stopAt,
    progress: () => {
      progress += 1;
    },
  };
  return { deps, asked, progress: () => progress, now: () => now };
}

describe("waiting for a network", () => {
  it("waits as long as there is none, asking every few seconds, and says when one is back", async () => {
    const c = clock({ backAt: 17_000 });
    expect(await waitForNetwork(c.deps)).toBe("back");
    expect(c.now()).toBeGreaterThanOrEqual(17_000);
    expect(c.now()).toBeLessThan(17_000 + NETWORK_POLL_MS + 1);
    // Asked at a steady pace, and never hammering.
    for (let i = 1; i < c.asked.length; i++) expect(c.asked[i]! - c.asked[i - 1]!).toBe(NETWORK_POLL_MS);
  });

  it("stays alive for the ladder's guard and the reconnect's ceiling while it waits", async () => {
    const c = clock({ backAt: 25_000 });
    await waitForNetwork(c.deps);
    expect(c.progress()).toBeGreaterThanOrEqual(Math.floor(25_000 / NETWORK_POLL_MS));
  });

  it("lets the same rung be dialled now and then anyway: the service decides, not the hint", async () => {
    // A way out the hint cannot see -- it reads no route -- must not wait
    // forever: every NETWORK_RETRY_ANYWAY_MS the rung is dialled again,
    // which costs nothing if the service still finds no network.
    const c = clock();
    expect(await waitForNetwork(c.deps)).toBe("retry");
    expect(c.now()).toBeGreaterThanOrEqual(NETWORK_RETRY_ANYWAY_MS);
    expect(c.now()).toBeLessThan(NETWORK_RETRY_ANYWAY_MS + NETWORK_POLL_MS + 1);
  });

  it("stops the moment the pass is told to", async () => {
    const c = clock({ stopAt: 9_000 });
    expect(await waitForNetwork(c.deps)).toBe("stopped");
    expect(c.now()).toBeLessThan(9_000 + NETWORK_POLL_MS + 1);
  });

  it("gives up after the same half hour an automatic reconnect waits for a network", async () => {
    expect(NETWORK_WAIT_MAX_MS).toBe(BLOCKED_WAIT_MAX_MS);
    const c = clock();
    // Already waited almost all of it on this rung, across earlier rounds.
    const since = -(NETWORK_WAIT_MAX_MS - 5_000);
    expect(await waitForNetwork(c.deps, since)).toBe("gaveUp");
    expect(c.now()).toBeLessThan(5_000 + NETWORK_POLL_MS + 1);
  });

  it("is said on screen while it waits, from a store a remounted screen reads", () => {
    const seen: boolean[] = [];
    const unsubscribe = networkWait.subscribe(() => seen.push(networkWait.current()));
    networkWait.set(true);
    networkWait.set(true);
    networkWait.set(false);
    unsubscribe();
    expect(seen).toEqual([true, false]);
  });
});

describe("the Windows ladder waits on the same rung", () => {
  const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
  const ladder = dashboard.slice(dashboard.indexOf("async function runLadder("), dashboard.indexOf("async function handleLogout("));
  const caught = ladder.slice(ladder.indexOf("const classified = classifyConnectionError(err);"));

  it("waits for a network instead of moving to the next server, and then dials the same rung", () => {
    const noNetwork = caught.indexOf('if (classified.kind === "noNetwork"');
    const waits = caught.indexOf("await waitForNetwork(");
    const again = caught.indexOf("index -= 1;");
    const recorded = caught.indexOf("failedRungs.push({ routeId: candidate.routeId, fate: rungFate(classified.kind) });");
    expect(noNetwork).toBeGreaterThan(0);
    expect(waits).toBeGreaterThan(noNetwork);
    expect(again).toBeGreaterThan(waits);
    // Nothing is recorded against the rung, the server or the route while
    // it waits: no failed dial, no fate, no error line.
    expect(recorded).toBeGreaterThan(again);
    const waiting = caught.slice(noNetwork, again);
    expect(waiting).not.toContain("attempts.push(");
    expect(waiting).not.toContain("dials.push(");
    expect(waiting).not.toContain("failedRungs.push(");
    // The same rung again: a `for` over an index, so it can be revisited.
    expect(ladder).toContain("for (let index = 0; index < candidates.length; index += 1) {");
  });

  it("goes no further down the ladder when it gives up on the network", () => {
    const gaveUp = caught.slice(caught.indexOf("lastError = { ...classified, detail: describeAttempts(attempts, candidates.length) };"));
    expect(gaveUp.slice(0, 400)).toMatch(/if \(classified\.kind === "noNetwork"\) break;/);
  });

  it("says so on screen and tells the reconnect, both ways, and keeps the pass alive", () => {
    const waiting = caught.slice(caught.indexOf('if (classified.kind === "noNetwork"'), caught.indexOf("index -= 1;"));
    expect(waiting).toContain("networkWait.set(true);");
    expect(waiting).toContain("networkWait.set(false);");
    expect(waiting).toContain("options.reconnect?.waitingForNetwork?.(true);");
    expect(waiting).toContain("options.reconnect?.waitingForNetwork?.(false);");
    expect(waiting).toContain("ladderPass.progress(generation);");
    expect(waiting).toContain('invoke<boolean>("network_way_out")');
    // And the store is cleared however the pass ends.
    const finallyBlock = ladder.slice(ladder.lastIndexOf("} finally {"));
    expect(finallyBlock).toContain("networkWait.set(false);");
  });

  it("is asked of a command the app registers", () => {
    const lib = readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
    expect(lib).toContain("vpn::network_way_out,");
    const vpn = readFileSync(new URL("../../src-tauri/src/vpn.rs", import.meta.url), "utf8");
    expect(vpn).toMatch(/#\[tauri::command\]\s+pub fn network_way_out\(\) -> bool \{/);
  });

  it("puts the words on screen while it waits", () => {
    expect(dashboard).toContain("const waitingForNetwork = useSyncExternalStore(networkWait.subscribe, networkWait.current);");
    expect(dashboard).toMatch(/headlineFor\(connectionState, \{[^}]*waitingForNetwork[^}]*\}\)/);
  });
});
