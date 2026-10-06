import { describe, expect, it } from "vitest";
import {
  API_ENDPOINT_MAX,
  LEGACY_API_ENDPOINT_MAX,
  beginAttempt,
  clipTrace,
  endpointLabel,
  failureOutcome,
  newTrace,
  renderTrace,
  settleAttempt,
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
