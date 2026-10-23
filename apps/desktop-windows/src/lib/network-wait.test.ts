import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BLOCKED_WAIT_MAX_MS } from "./auto-reconnect";
import {
  NETWORK_FIRST_LOOK_MS,
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
  it("waits as long as there is none, asking at most every few seconds, and says when one is back", async () => {
    const c = clock({ backAt: 17_000 });
    expect(await waitForNetwork(c.deps)).toBe("back");
    expect(c.now()).toBeGreaterThanOrEqual(17_000);
    expect(c.now()).toBeLessThan(17_000 + NETWORK_POLL_MS + 1);
    // Never further apart than the steady pace, and slowing towards it.
    for (let i = 1; i < c.asked.length; i++) {
      const gap = c.asked[i]! - c.asked[i - 1]!;
      expect(gap).toBeLessThanOrEqual(NETWORK_POLL_MS);
      expect(gap).toBeGreaterThanOrEqual(c.asked[i - 1]! - (c.asked[i - 2] ?? 0) - 1);
    }
  });

  // On the VM, the guest's link off for four seconds: the reconnect's dial
  // was refused for want of a network 1.5 s after the address came back --
  // the default route not there yet -- and the first look again came two
  // seconds after the refusal, whatever had come back meanwhile. With the
  // settle and the IPv6 baseline after it, the dial again was 4.5 s after
  // the refusal, the gap passed the ten seconds the screen holds its
  // colour for, and the button went amber.
  it("looks again soon after a refusal: the network that was just coming back usually is", async () => {
    for (const backAt of [100, 300, 700, 1_200, 2_500, 4_000]) {
      const c = clock({ backAt });
      expect(await waitForNetwork(c.deps)).toBe("back");
      // Noticed within a quarter of the time it took, or the first look.
      expect(c.now() - backAt, `back at ${backAt}`).toBeLessThanOrEqual(Math.max(NETWORK_FIRST_LOOK_MS, backAt / 4));
    }
    expect(NETWORK_FIRST_LOOK_MS).toBeLessThanOrEqual(250);
  });

  it("looks no more often than a few times a second, and fewer the longer it waits", async () => {
    const c = clock();
    expect(await waitForNetwork(c.deps)).toBe("retry");
    // A local table read each: under one a second on average over a round.
    expect(c.asked.length).toBeLessThan(NETWORK_RETRY_ANYWAY_MS / 1_000);
    expect(c.asked[0]).toBe(NETWORK_FIRST_LOOK_MS);
  });

  it("dials a way out the service keeps refusing at a slowing pace, never faster than at first", async () => {
    // The hint and the service ask two different questions of the routing
    // table. Should they disagree for good -- a way out here, none there --
    // every look says "back" and every dial is refused. Each refusal on
    // the same rung puts the next dial further off, up to the steady pace.
    const firstLooks: number[] = [];
    for (let round = 0; round < 6; round++) {
      const c = clock({ backAt: 0 });
      expect(await waitForNetwork(c.deps, 0, round)).toBe("back");
      firstLooks.push(c.now());
    }
    expect(firstLooks).toEqual([250, 500, 1_000, 2_000, 2_000, 2_000]);
    expect(Math.max(...firstLooks)).toBe(NETWORK_POLL_MS);
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
    expect(waiting).toContain("showNetworkWait(true);");
    expect(waiting).toContain("ladderPass.progress(generation);");
    expect(waiting).toContain('invoke<boolean>("network_way_out", { payload: candidate })');
    // One place says it, to the store and to the reconnect, both ways.
    const helper = ladder.slice(ladder.indexOf("const showNetworkWait = (on: boolean) => {"));
    expect(helper.slice(0, 600)).toContain("networkWait.set(on);");
    expect(helper.slice(0, 600)).toContain("options.reconnect?.waitingForNetwork?.(on);");
    // And it is cleared however the pass ends.
    const finallyBlock = ladder.slice(ladder.lastIndexOf("} finally {"));
    expect(finallyBlock).toContain("showNetworkWait(false);");
  });

  const retried = caught.slice(caught.indexOf('if (waited === "back" || waited === "retry") {'), caught.indexOf("continue;"));

  it("keeps saying it is waiting through a retry the service refuses again, until a dial is taken", () => {
    // Cleared before each retry, the headline went to "Reconnecting..." for
    // the few seconds every 30 s retry took to be refused again, and back.
    expect(retried.length).toBeGreaterThan(0);
    expect(retried).not.toContain("showNetworkWait(false)");
    const taken = ladder.slice(ladder.indexOf('await invoke("vpn_connect", {'));
    const close = taken.indexOf("});");
    expect(taken.slice(close, close + 120)).toContain("showNetworkWait(false);");
    // An outcome other than no network ends the wait too.
    expect(caught.slice(0, 200)).toContain('if (classified.kind !== "noNetwork") showNetworkWait(false);');
  });

  it("lets only the pass that owns the ladder clear the shared wait", () => {
    // A pass superseded mid-wait cleared a newer pass's "Waiting for a
    // network connection" when its own wait came back "stopped".
    const sets = ladder.match(/[^\n]*networkWait\.set\([^\n]*/g) ?? [];
    expect(sets.length).toBeGreaterThan(0);
    for (const line of sets) expect(line).toContain("if (ladderGenerationRef.current === generation) networkWait.set(");
  });

  it("starts the pass again from its first rung when rungs before the wait failed", () => {
    // fi passed the way-out check, Wi-Fi went while it was dialled, fi
    // timed out, sg was refused for no network and waited -- and the
    // network back, the pass dialled sg: another country. And the notice
    // then said fi did not get through, over a network that had left.
    expect(retried).toMatch(/if \(index > 0\) \{[^}]*failedRungs\.length = 0;[^}]*lastError = null;[^}]*index = -1;/);
  });

  it("files nothing against the rungs before the wait in the pass's report, either", () => {
    // The CONNECT report pairs `attempts` and `dials` by index; left as they
    // were, it filed fi as dialled and not carrying over a network that had
    // gone, though the screen said nothing against it.
    expect(retried).toMatch(/if \(index > 0\) \{[^}]*attempts\.length = 0;[^}]*dials\.length = 0;[^}]*index = -1;/);
  });

  it("takes the IPv6 baseline again on the network that is back", () => {
    // Taken at the first rung of a pass that began with no network, it
    // said "no IPv6 here" of a network that has it, and the "IPv6 blocked"
    // notice was never shown.
    expect(retried).toContain("ipv6BaselineRef.current = null;");
  });

  it("tells the wait how many times this rung has waited, and forgets it when the ladder moves on", () => {
    const waiting = caught.slice(caught.indexOf('if (classified.kind === "noNetwork"'), caught.indexOf("index -= 1;"));
    expect(waiting).toMatch(/await waitForNetwork\(\s*\{[\s\S]*\},\s*noNetworkSince,\s*noNetworkRounds,\s*\);/);
    expect(waiting).toContain("noNetworkRounds += 1;");
    expect(ladder).toContain("let noNetworkRounds = 0;");
    expect(ladder).toMatch(/noNetworkSince = null;\s*noNetworkRounds = 0;/);
  });

  // The other half of the VM's 4.5 s from a refusal to the dial again: the
  // IPv6 baseline, taken after the settle, waited out its probe's timeout
  // on a network with IPv6 addresses and no IPv6 route -- two seconds.
  it("takes the IPv6 baseline beside the settle when the rung is dialled again after a wait", () => {
    expect(retried).toContain("redialAfterWait = true;");
    const prologue = ladder.slice(
      ladder.indexOf("for (let index = 0; index < candidates.length; index += 1) {"),
      ladder.indexOf('await invoke("vpn_connect", {'),
    );
    const beside = prologue.indexOf(
      "const ipv6Beside = redialAfterWait && ipv6BaselineRef.current === null ? captureIpv6Baseline() : null;",
    );
    const settle = prologue.indexOf("baselineIpRef.current = await settleAndCaptureBaseline(");
    expect(beside).toBeGreaterThan(0);
    expect(beside).toBeLessThan(settle);
    expect(prologue).toContain("redialAfterWait = false;");
    expect(prologue).toContain("ipv6BaselineRef.current = await (ipv6Beside ?? captureIpv6Baseline());");
  });

  it("is asked of a command the app registers", () => {
    const lib = readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
    expect(lib).toContain("vpn::network_way_out,");
    const vpn = readFileSync(new URL("../../src-tauri/src/vpn.rs", import.meta.url), "utf8");
    expect(vpn).toMatch(/#\[tauri::command\]\s+pub async fn network_way_out\(payload: Option<ProtocolUserPayload>\) -> bool \{/);
  });

  // 2026-10-20 review: the app's rule was a copy of the service's, and had
  // drifted -- GetBestRoute toward 1.1.1.1 and any default route on an up
  // adapter, where the service asks toward the rung's own server, skips a
  // leftover host route and needs an up adapter with a gateway. The hint is
  // now the service's answer, its copy kept only for a service that cannot
  // give one.
  it("asks the service, toward the rung's own server, before reading the tables itself", () => {
    const vpn = readFileSync(new URL("../../src-tauri/src/vpn.rs", import.meta.url), "utf8");
    const command = vpn.slice(vpn.indexOf("pub async fn network_way_out("), vpn.indexOf("const WAY_OUT_REPLY_TIMEOUT"));
    const asked = command.indexOf("call_within(&Request::WayOut { profile }, WAY_OUT_REPLY_TIMEOUT)");
    expect(asked).toBeGreaterThan(0);
    expect(command.indexOf("local_way_out()")).toBeGreaterThan(asked);
    const pipe = readFileSync(new URL("../../service/src/pipe.rs", import.meta.url), "utf8");
    expect(pipe).toContain("Request::WayOut { profile } => {");
    expect(pipe).toContain("crate::engines::way_out_for(&profile)");
    const engines = readFileSync(new URL("../../service/src/engines/mod.rs", import.meta.url), "utf8");
    expect(engines).toContain("finds_a_way_out(adapters::best_uplink_for(way_out_probe(profile), &OUR_ADAPTER_NAMES))");
  });

  // The VM, cable out for 25 s: the hint said there was a way out at every
  // first look while the service refused every dial for want of one, so
  // each wait ended at once and each round cost a settle of two to four
  // seconds and a refused dial -- and after a 3 s unplug the dial again came
  // 4.4 s after the refusal, the quarter-second look having said yes too
  // soon. The hint asked for Windows' best route alone, wherever it led;
  // the service takes a route only on an adapter that is up and not one of
  // ours (adapters::choose_uplink).
  it("asks the service's question: a route only on an adapter that is up and not one of ours", () => {
    const vpn = readFileSync(new URL("../../src-tauri/src/vpn.rs", import.meta.url), "utf8");
    const hint = vpn.slice(vpn.indexOf("fn local_way_out() -> bool {"), vpn.indexOf("#[cfg(test)]\nmod way_out_tests"));
    expect(hint).toContain("way_out_from(best, &defaults, |index| interface_state(index).is_some_and(|(up, alias)| usable_adapter(up, &alias)))");
    expect(hint).toMatch(/fn way_out_from\(best: Option<u32>, defaults: &\[\(u32, u32\)\], usable: impl Fn\(u32\) -> bool\) -> bool \{\s*if best\.is_some_and\(&usable\) \{\s*return true;\s*\}\s*defaults\.iter\(\)\.any\(\|&\(index, _\)\| usable\(index\)\)/);
    expect(hint).toContain("up && !OUR_ADAPTERS.contains(&alias)");
    // Up as the service reads it: the NDIS operational state.
    expect(hint).toContain("row.OperStatus == IfOperStatusUp");
    const adapters = readFileSync(new URL("../../service/src/adapters.rs", import.meta.url), "utf8");
    expect(adapters).toContain("is_up: entry.OperStatus == IF_OPER_STATUS_UP,");
    expect(adapters).toMatch(/adapter\.is_some_and\(\|a\| a\.is_up && !exclude\.contains\(&a\.name\.as_str\(\)\)\)/);
    // Ours, by the names the service gives them.
    const engine = (file: string, name: string) => {
      const source = readFileSync(new URL(`../../service/src/engines/${file}`, import.meta.url), "utf8");
      const found = new RegExp(`pub const ${name}: &str = "([^"]+)";`).exec(source);
      expect(found, `${file} ${name}`).not.toBeNull();
      return found![1];
    };
    const ours = [
      engine("xray.rs", "ADAPTER_NAME"),
      engine("wireguard.rs", "TUNNEL_NAME"),
      engine("openvpn.rs", "ADAPTER_NAME"),
      engine("ikev2.rs", "ENTRY_NAME"),
    ];
    expect(vpn).toContain(`const OUR_ADAPTERS: [&str; 4] = [${ours.map((n) => `"${n}"`).join(", ")}];`);
    const mod = readFileSync(new URL("../../service/src/engines/mod.rs", import.meta.url), "utf8");
    expect(mod).toMatch(/const OUR_ADAPTER_NAMES: \[&str; 4\] =\s*\[xray::ADAPTER_NAME, wireguard::TUNNEL_NAME, openvpn::ADAPTER_NAME, ikev2::ENTRY_NAME\];/);
  });

  it("puts the words on screen while it waits", () => {
    expect(dashboard).toContain("const waitingForNetwork = useSyncExternalStore(networkWait.subscribe, networkWait.current);");
    expect(dashboard).toMatch(/headlineFor\(connectionState, \{[^}]*waitingForNetwork[^}]*\}\)/);
  });
});
