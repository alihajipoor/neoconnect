import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  GONE_LOOKS,
  NEW_UPLINK_WATCH,
  UPLINK_POLL_MS,
  UPLINK_RECHECK_MS,
  afterUplinkRecheck,
  nextUplink,
  withinMs,
  type UplinkWatch,
} from "./uplink-watch";

/** Measured on the VM (P3 runs n-01 and r-01, 2026-10-12): after the link
 * dropped, "You're protected" stayed about 20 s over a tunnel that could
 * not carry anything, and about 26 s after a roam -- the fifteen-second
 * health poll's interval plus its egress walk. These are the rules that
 * notice the way out changing within a second and re-verify at once. */

const HOME = "7>192.168.1.1@192.168.1.20";
const CAFE = "7>10.77.7.1@10.77.7.3";

function looks(sequence: (string | null)[], from: UplinkWatch = NEW_UPLINK_WATCH) {
  let watch = from;
  const steps: string[] = [];
  for (const seen of sequence) {
    const [next, step] = nextUplink(watch, seen);
    watch = next;
    steps.push(step);
  }
  return { watch, steps };
}

describe("watching the way out under a tunnel", () => {
  it("takes the session's first look as what the tunnel was proven over", () => {
    expect(looks([HOME]).steps).toEqual(["same"]);
    expect(looks([HOME, HOME, HOME]).steps).toEqual(["same", "same", "same"]);
  });

  it("re-verifies the moment the way out changes -- a roam, a new address, a second link", () => {
    expect(looks([HOME, CAFE]).steps).toEqual(["same", "recheck"]);
    // The same gateway on another network: only the address changed.
    expect(looks([HOME, "7>192.168.1.1@192.168.1.57"]).steps).toEqual(["same", "recheck"]);
    // Once per change, not on every look after it.
    expect(looks([HOME, CAFE, CAFE, CAFE]).steps).toEqual(["same", "recheck", "same", "same"]);
  });

  it("calls the tunnel unable to carry once no way out is seen twice running", () => {
    expect(GONE_LOOKS).toBe(2);
    expect(looks([HOME, ""]).steps).toEqual(["same", "same"]);
    expect(looks([HOME, "", ""]).steps).toEqual(["same", "same", "lost"]);
    // And says so once.
    expect(looks([HOME, "", "", "", ""]).steps).toEqual(["same", "same", "lost", "same", "same"]);
  });

  it("re-verifies after a blip, even back on the same network", () => {
    // The link went for a second and came back: the routes the tunnel's
    // own connection used may have gone with it.
    expect(looks([HOME, "", HOME]).steps).toEqual(["same", "same", "recheck"]);
    expect(looks([HOME, "", CAFE]).steps).toEqual(["same", "same", "recheck"]);
    // Back after "lost": a network is back, which is the reconnect's to use.
    expect(looks([HOME, "", "", CAFE]).steps).toEqual(["same", "same", "lost", "recheck"]);
  });

  it("does nothing on a look it could not take", () => {
    expect(looks([HOME, null, null, HOME]).steps).toEqual(["same", "same", "same", "same"]);
    expect(looks([null, HOME, CAFE]).steps).toEqual(["same", "same", "recheck"]);
    // A failed look neither counts towards "lost" nor resets the count.
    expect(looks([HOME, "", null, ""]).steps).toEqual(["same", "same", "same", "lost"]);
  });

  it("leaves a session that began with no way out it can see alone", () => {
    // PPP lines and the like: what it reads is not a way out it knows, so
    // its absence is not news.
    expect(looks(["", "", "", ""]).steps).toEqual(["same", "same", "same", "same"]);
    expect(looks(["", HOME]).steps).toEqual(["same", "recheck"]);
  });

  it("is fast enough to say so within about three seconds", () => {
    // A look a second, two looks to call "lost"; a change re-verified
    // within its own ceiling.
    expect(UPLINK_POLL_MS * GONE_LOOKS).toBeLessThanOrEqual(2_000);
    expect(UPLINK_POLL_MS + UPLINK_RECHECK_MS).toBeLessThanOrEqual(3_500);
  });
});

describe("what a re-verification after a change means", () => {
  it("shows what it proved, and restores 'protected' only on proof", () => {
    expect(afterUplinkRecheck("connected")).toBe("show");
    // Traffic flows but nothing could be compared, or Custom mode's probe
    // did not answer: the poll's own honest middle, never "protected".
    expect(afterUplinkRecheck("unverified")).toBe("show");
  });

  it("calls the tunnel unable to carry on a measured no, and on no answer in time", () => {
    expect(afterUplinkRecheck("degraded")).toBe("lost");
    expect(afterUplinkRecheck("timedOut")).toBe("lost");
  });

  it("leaves a gone tunnel and an unanswered service to the polls that own them", () => {
    expect(afterUplinkRecheck("disconnected")).toBe("ignore");
    expect(afterUplinkRecheck("unknown")).toBe("ignore");
  });
});

describe("withinMs", () => {
  it("answers with the promise when it is in time, and with the fallback when it is not", async () => {
    vi.useFakeTimers();
    try {
      const quick = withinMs(Promise.resolve("connected" as const), 100, "timedOut" as const);
      await expect(quick).resolves.toBe("connected");
      const slow = withinMs(new Promise<"connected">(() => undefined), 100, "timedOut" as const);
      vi.advanceTimersByTime(100);
      await expect(slow).resolves.toBe("timedOut");
      const failing = withinMs(Promise.reject(new Error("no")), 100, "timedOut" as const);
      await expect(failing).resolves.toBe("timedOut");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the dashboard's wiring", () => {
  const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
  const effectStart = dashboard.indexOf('invoke<string | null>("network_uplinks")');
  const effect = dashboard.slice(dashboard.lastIndexOf("useEffect(() => {", effectStart), dashboard.indexOf("}, [connectionState]);", effectStart));

  it("looks at the way out every second while a tunnel is up", () => {
    expect(effectStart).toBeGreaterThan(0);
    expect(effect).toContain("if (!isTunnelUp(connectionState)) {");
    expect(effect).toContain("uplinkRef.current = NEW_UPLINK_WATCH;");
    expect(effect).toContain("setInterval(() => void look(), UPLINK_POLL_MS)");
    expect(effect).toContain("nextUplink(uplinkRef.current, seen)");
  });

  it("stays out of the way of what owns the tunnel", () => {
    expect(effect).toMatch(/if \(ladderInFlight\(\) \|\| repairUnderWay\(\)\) return;/);
    expect(effect).toContain('if (intentRef.current.intent !== "idle") return;');
    expect(effect).toContain("if (statusDisturbances.busy()) return;");
  });

  it("hands a tunnel that cannot carry to the reconnect, and shows only what it proved", () => {
    expect(effect).toContain('if (step === "lost")');
    expect(effect).toContain("publishCarrierLost(generation)");
    expect(effect).toContain("afterUplinkRecheck(verdict)");
    expect(effect).toMatch(/action === "show"[\s\S]*publishObserved\(generation, verdict\)/);
  });

  it("makes the fifteen-second poll's reading about the old way out old news", () => {
    expect(effect).toContain("uplinkEpochRef.current += 1;");
    const measure = dashboard.slice(dashboard.indexOf("const measure = async (): Promise<boolean> => {"));
    expect(measure).toContain("const uplinkEpoch = uplinkEpochRef.current;");
    expect(measure).toContain("if (uplinkEpochRef.current !== uplinkEpoch) return false;");
  });

  it("re-verifies within its ceiling, Custom mode by the service's probe", () => {
    const recheck = dashboard.slice(dashboard.indexOf("async function recheckAfterUplinkChange("));
    expect(recheck).toContain("withinMs(");
    expect(recheck).toContain("UPLINK_RECHECK_MS");
    expect(recheck).toContain('invoke("vpn_probe_split_tunnel")');
    expect(recheck).toContain("statusDisturbances.begin(PROBE_CAP_MS)");
    expect(recheck).toContain("totalMs: UPLINK_RECHECK_MS");
  });

  it("drops the tunnel as a drop is dropped -- the existing reconnect -- and tears it down when nothing will reconnect", () => {
    const lost = dashboard.slice(dashboard.indexOf("function publishCarrierLost("));
    expect(lost).toContain("if (slotLostRef.current || slotTeardown.owed()) return;");
    expect(lost).toContain("if (!publishDrop(generation)) return;");
    expect(lost).toMatch(/autoReconnect\.current\(\)\.kind[\s\S]*void serviceDisconnect\(\)/);
  });

  it("is asked of a command the app registers", () => {
    const lib = readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");
    expect(lib).toContain("vpn::network_uplinks,");
    const vpn = readFileSync(new URL("../../src-tauri/src/vpn.rs", import.meta.url), "utf8");
    expect(vpn).toMatch(/#\[tauri::command\]\s+pub fn network_uplinks\(\) -> Option<String> \{/);
  });
});
