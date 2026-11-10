import { describe, expect, it } from "vitest";
import {
  API_ENDPOINT_MAX,
  LEGACY_API_ENDPOINT_MAX,
  beginAttempt,
  beginDoorAttempt,
  clipTrace,
  endpointLabel,
  failureOutcome,
  newTrace,
  renderTrace,
  settleAttempt,
  settleDoorAttempt,
  withdrawDoorAttempt,
} from "./endpoint-trace";

/** Names are RFC 2606 stand-ins; the real endpoint list is never
 * committed (docs/node-address-hygiene.md). */
const PANEL = "https://connect.example.net/api";
const MIRROR = "https://edge-1.example.org:2053/api";

describe("endpointLabel", () => {
  /** Mirrors share a hostname across ports; the port is what tells them
   * apart, so it stays unless it is the default. */
  it("keeps a non-default port and drops the scheme and path", () => {
    expect(endpointLabel(PANEL)).toBe("connect.example.net");
    expect(endpointLabel(MIRROR)).toBe("edge-1.example.org:2053");
    expect(endpointLabel("http://localhost:4000")).toBe("localhost:4000");
  });

  it("never throws on something that is not a URL", () => {
    expect(endpointLabel("not a url")).toBe("?");
  });
});

describe("failureOutcome", () => {
  /** The plugin rejects with its Rust error's text. A scope refusal is
   * decided on the device and is a build fault, not a network one. */
  it("separates a scope refusal from every network failure", () => {
    expect(failureOutcome("url not allowed on the configured scope: https://x.example/api")).toBe("scope");
    expect(failureOutcome("error sending request for url (https://x.example/api/customer/me)")).toBe("net");
    expect(failureOutcome(new Error("Request cancelled"))).toBe("net");
    expect(failureOutcome(undefined)).toBe("net");
  });
});

describe("a request this machine refused", () => {
  /** WSAEACCES, Windows' "os error 10013": a filter on this PC refused the
   * socket before anything was sent -- ours (the IPv6 block, or a future
   * IPv4 one) or another product's firewall. Not a fact about the network,
   * and above all not censorship: read as `net`, it would be probed as a
   * blocked address and counted in the panel against a network that never
   * saw the request.
   *
   * For an error that carries its cause -- this app's own commands, or a
   * plugin that one day passes it on. The HTTP plugin's do not; see the
   * next test. The string below is a stand-in shaped like one that does,
   * not one the plugin produces. */
  it("wsaeacces_is_not_recorded_as_blocking", () => {
    const refused = "connect failed: An attempt was made to access a socket in a way forbidden by its access permissions. (os error 10013)";
    expect(failureOutcome(refused)).toBe("local");
    expect(failureOutcome(new Error(refused))).toBe("local");
    expect(failureOutcome("connect failed: WSAEACCES")).toBe("local");
    // Not every number that starts the same way.
    expect(failureOutcome("connect failed (os error 100130)")).toBe("net");

    const trace = newTrace();
    settleAttempt(beginAttempt(trace, MIRROR, 1_000), failureOutcome(refused), 1_012);
    expect(renderTrace(trace)).toBe("req: edge-1.example.org:2053=local@12");
  });

  /** What the HTTP plugin (2.5.9) actually rejects with when a filter on
   * this PC refuses the connect: reqwest's Display, which names the URL and
   * leaves the OS error out. Pinned so that nobody reads the test above as
   * covering a request: through the plugin, a local refusal is `net`, and
   * only the probe tells it apart (`REFUSED_HERE_REASON` in
   * control-plane-probe.ts). */
  it("cannot tell a local refusal through the HTTP plugin, whose error has no cause", () => {
    expect(failureOutcome("error sending request for url (https://edge-1.example.org:2053/api/health)")).toBe("net");
  });
});

describe("renderTrace", () => {
  it("writes each attempt as host=outcome@ms, grouped by leg, in order", () => {
    const trace = newTrace();
    const a = beginAttempt(trace, PANEL, 1_000);
    const b = beginAttempt(trace, MIRROR, 1_000);
    settleAttempt(a, "h401", 1_420);
    settleAttempt(b, "cancel", 1_421);
    trace.phase = "refresh";
    const c = beginAttempt(trace, PANEL, 1_500);
    settleAttempt(c, "timeout", 9_501);

    expect(renderTrace(trace, 10_000)).toBe(
      "req: connect.example.net=h401@420 edge-1.example.org:2053=cancel@421; refresh: connect.example.net=timeout@8001",
    );
  });

  /** The whole reason the old field could not explain a failed refresh:
   * the budget ran out while an address was still being waited on. */
  it("writes an attempt still in flight as the budget running out", () => {
    const trace = newTrace();
    beginAttempt(trace, PANEL, 0);
    expect(renderTrace(trace, 6_000)).toBe("req: connect.example.net=budget@6000");
  });

  it("is empty when nothing was tried", () => {
    expect(renderTrace(newTrace())).toBe("");
  });

  /** A response that arrived before the race was called is a response;
   * the abort that follows must not rewrite it. */
  it("keeps the first way an attempt ended", () => {
    const trace = newTrace();
    const a = beginAttempt(trace, PANEL, 0);
    settleAttempt(a, "h200", 300);
    settleAttempt(a, "cancel", 310);
    expect(renderTrace(trace)).toBe("req: connect.example.net=h200@300");
  });

  it("records nothing when nobody is tracing", () => {
    expect(beginAttempt(undefined, PANEL)).toBeUndefined();
    expect(() => settleAttempt(undefined, "net")).not.toThrow();
  });

  /** It goes to a table anyone can post to and an operator reads. Only
   * an address and a class: never a path, a query or a credential. */
  it("carries no path, query or credential", () => {
    const trace = newTrace();
    settleAttempt(beginAttempt(trace, "https://user:secret@connect.example.net/api?token=abc", 0), "net", 5);
    const line = renderTrace(trace);
    expect(line).toBe("req: connect.example.net=net@5");
    expect(line).not.toMatch(/secret|token|api/);
  });
});

describe("clipTrace", () => {
  const entry = (i: number) => `edge-${i}.example.org:2053=timeout@8000`;
  const long = Array.from({ length: 30 }, (_, i) => entry(i)).join(" ");
  const ENTRY = /^edge-\d+\.example\.org:2053=timeout@8000$/;

  /** The entries left, in order, and what the marks say was cut. */
  function read(clipped: string) {
    const kept: string[] = [];
    let cut = 0;
    for (const section of clipped.split("; ")) {
      const mark = /^\[(\d+) cut\]$/.exec(section);
      if (mark) {
        cut += Number(mark[1]);
        continue;
      }
      kept.push(...section.replace(/^[a-z]+: /, "").split(" "));
    }
    return { kept, cut };
  }

  it("leaves a trace that fits alone", () => {
    expect(clipTrace("req: a.example=net@3", 200)).toBe("req: a.example=net@3");
  });

  /** Over the limit the server refuses the whole report with a 400. */
  it("cuts whole entries from the middle, says how many, and fits", () => {
    for (const max of [LEGACY_API_ENDPOINT_MAX, 500, 64]) {
      const clipped = clipTrace(`req: ${long}`, max);
      expect(clipped.length).toBeLessThanOrEqual(max);
      const { kept, cut } = read(clipped);
      for (const part of kept) expect(part).toMatch(ENTRY);
      // Nothing unaccounted for.
      expect(kept.length + cut).toBe(30);
      expect(cut).toBeGreaterThan(0);
    }
  });

  /** Where the walk started and how it ended outlast the run between. */
  it("keeps the first and the last entry while it can", () => {
    const clipped = clipTrace(`req: ${long}`, LEGACY_API_ENDPOINT_MAX);
    expect(clipped.startsWith(`req: ${entry(0)}`)).toBe(true);
    expect(clipped.endsWith(entry(29))).toBe(true);
    expect(clipped).toMatch(/; \[\d+ cut\]; req: /);
  });

  /** The probe answer comes last, and is the one part nothing else can
   * reconstruct. Cutting from the end removed it first. */
  it("keeps the probe section and cuts the attempts instead", () => {
    const probe = "probe: connect.example.net=dns@40 edge-1.example.org:2053=tls-timeout@4001";
    for (const max of [LEGACY_API_ENDPOINT_MAX, 500]) {
      const clipped = clipTrace(`req: ${long}; ${probe}`, max);
      expect(clipped.length).toBeLessThanOrEqual(max);
      expect(clipped.endsWith(`; ${probe}`)).toBe(true);
      expect(clipped.startsWith(`req: ${entry(0)}`)).toBe(true);
      expect(read(clipped.slice(0, -probe.length - 2)).kept.length + read(clipped).cut).toBe(30);
    }
  });

  /** A probe too long to fit beside even two attempts loses its own
   * middle -- only after the attempts are down to their first and last. */
  it("cuts a long probe's middle only when the attempts cannot give more", () => {
    const answers = Array.from({ length: 16 }, (_, i) => `edge-${i}.example.org:2053=tcp-timeout@4001`).join(" ");
    const clipped = clipTrace(`req: ${long}; probe: ${answers}`, LEGACY_API_ENDPOINT_MAX);
    expect(clipped.length).toBeLessThanOrEqual(LEGACY_API_ENDPOINT_MAX);
    expect(clipped).toContain("probe: edge-0.example.org:2053=tcp-timeout@4001");
    expect(clipped.endsWith("probe: edge-15.example.org:2053=tcp-timeout@4001")).toBe(true);
    // Attempts and answers together, every one accounted for.
    const { kept, cut } = read(clipped);
    expect(kept.length + cut).toBe(30 + 16);
  });

  /** Fitted to 2000 before sending and to 200 again for an old server:
   * the second cut adds to the first mark instead of stacking a new one. */
  it("counts an earlier cut into a later one", () => {
    const once = clipTrace(`req: ${long} ${long}`, 500);
    const twice = clipTrace(once, LEGACY_API_ENDPOINT_MAX);
    expect(twice.length).toBeLessThanOrEqual(LEGACY_API_ENDPOINT_MAX);
    expect(twice.match(/\[\d+ cut\]/g)).toHaveLength(1);
    const { kept, cut } = read(twice);
    expect(kept.length + cut).toBe(60);
  });

  it("never leaves a dangling phase separator", () => {
    const text = "req: a.example=net@3; refresh: " + "b".repeat(300);
    expect(clipTrace(text, 40)).toBe("req: a.example=net@3; [1 cut]");
  });

  it("fits the server's limit", () => {
    expect(clipTrace("x".repeat(5_000), API_ENDPOINT_MAX).length).toBeLessThanOrEqual(API_ENDPOINT_MAX);
  });
});

/** The doors a request was offered to (server-doors.ts) are written after
 * the addresses by name, each as it ended, and only the ones asked. The
 * addresses are documentation ones. */
describe("the doors in a trace", () => {
  it("are rendered after the legs by name, with how each ended", () => {
    const trace = newTrace();
    settleAttempt(beginAttempt(trace, PANEL, 0), "timeout", 10_004);
    settleDoorAttempt(beginDoorAttempt(trace, "192.0.2.7:2053", 10_010), "pin", 10_320);
    settleDoorAttempt(beginDoorAttempt(trace, "192.0.2.9:2096", 10_330), "h200", 10_750);
    expect(renderTrace(trace, 11_000)).toBe(
      "req: connect.example.net=timeout@10004; door: 192.0.2.7:2053=pin@310 192.0.2.9:2096=h200@420",
    );
  });

  it("leave a trace with no door as it always was", () => {
    const trace = newTrace();
    settleAttempt(beginAttempt(trace, PANEL, 0), "h200", 80);
    expect(trace).toEqual({ phase: "req", entries: trace.entries });
    expect(renderTrace(trace, 100)).toBe("req: connect.example.net=h200@80");
    expect(beginDoorAttempt(undefined, "192.0.2.7:2053")).toBeUndefined();
  });

  it("say budget for a door still being asked, and nothing for one never dialled", () => {
    const trace = newTrace();
    beginDoorAttempt(trace, "192.0.2.7:2053", 1_000);
    const refused = beginDoorAttempt(trace, "192.0.2.9:2096", 1_200);
    withdrawDoorAttempt(trace, refused);
    expect(renderTrace(trace, 1_250)).toBe("door: 192.0.2.7:2053=budget@250");
    // The first settlement wins, as for an address.
    settleDoorAttempt(trace.doors?.[0], "timeout", 5_000);
    settleDoorAttempt(trace.doors?.[0], "h200", 6_000);
    expect(renderTrace(trace, 9_000)).toBe("door: 192.0.2.7:2053=timeout@4000");
    withdrawDoorAttempt(trace, trace.doors?.[0]);
    expect(trace.doors).toBeUndefined();
  });

  it("are cut with the rest when the field has to fit", () => {
    const names = Array.from({ length: 30 }, (_, i) => `n${i}.example.org=timeout@10000`).join(" ");
    const text = `req: ${names}; door: 192.0.2.7:2053=timeout@4000 192.0.2.9:2096=h200@420`;
    const clipped = clipTrace(text, LEGACY_API_ENDPOINT_MAX);
    expect(clipped.length).toBeLessThanOrEqual(LEGACY_API_ENDPOINT_MAX);
    // How it ended is kept: the door that answered is the last entry.
    expect(clipped.endsWith("192.0.2.9:2096=h200@420")).toBe(true);
    expect(clipped.startsWith("req: n0.example.org=timeout@10000")).toBe(true);
  });
});
