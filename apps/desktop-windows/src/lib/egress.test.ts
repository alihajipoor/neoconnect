import { afterEach, describe, expect, it, vi } from "vitest";

/** The endpoint list, stood in for so the fallback order can be driven
 * from a test without a Tauri store. */
const endpoints = vi.fn<() => Promise<string[]>>();
/** Every `/health/ip` answer, keyed by the base URL that would serve it.
 * A base missing from the map is treated as unreachable. `hang` never
 * answers and ends only when the caller aborts -- what a request made in
 * a new adapter's first seconds was measured doing. */
type Answer = { ip: string } | "unreachable" | "hang";
const answers = new Map<string, Answer>();
/** Answers given one per request, in order, before `answers` applies --
 * for an endpoint whose behaviour changes while a tunnel comes up. */
const scripts = new Map<string, Answer[]>();
/** Which bases were asked, in order. */
const asked: string[] = [];

vi.mock("./api-endpoints", () => ({ apiEndpoints: () => endpoints() }));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string, init?: { signal?: AbortSignal }) => {
    const base = url.replace(/\/health\/ip$/, "");
    asked.push(base);
    const answer = scripts.get(base)?.shift() ?? answers.get(base);
    if (answer === "hang") {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("Request canceled")));
      });
    }
    if (answer === undefined || answer === "unreachable") {
      return Promise.reject(new Error(`no route to ${base}`));
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(answer) });
  },
}));

// The IPv6 half of the module reaches for a Tauri command it has no
// business invoking here.
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("not used")) }));

const { captureBaselineIp, verifyEgress, confirmEgressWithin } = await import("./egress");

/** The real production list, in the real order (`config.ts`). The first
 * entry is the Cloudflare-fronted panel; the rest are node mirrors.
 *
 * The IP literals below are RFC 5737 documentation addresses standing in
 * for real ones: 203.0.113.x for a node exit, 192.0.2.x for a customer's
 * own line. Only the fact that they differ is under test. See
 * docs/node-address-hygiene.md. */
const CDN = "https://connect.neoxify.site/api";
const FI_MIRROR = "https://fi1.neoxify.site:2053/api";

afterEach(() => {
  endpoints.mockReset();
  answers.clear();
  scripts.clear();
  asked.length = 0;
});

/** The client's real address, as the CDN reports it. */
const CLIENT = "192.0.2.228";
/** A node's own address (redacted), as a mirror with a broken
 * `X-Forwarded-For` chain reports it -- measured on turkey-1, where the
 * mirror proxies to the Cloudflare-fronted panel and Cloudflare
 * overwrites `cf-connecting-ip` with the node. */
const NODE = "203.0.113.20";

describe("comparing the address the world sees", () => {
  it("calls a changed address through the same endpoint proof", async () => {
    endpoints.mockResolvedValue([CDN]);
    answers.set(CDN, { ip: CLIENT });
    const baseline = await captureBaselineIp();

    answers.set(CDN, { ip: "203.0.113.10" });
    await expect(verifyEgress(baseline)).resolves.toEqual({
      state: "throughTunnel",
      exitIp: "203.0.113.10",
    });
  });

  it("calls an unchanged address through the same endpoint a leak", async () => {
    endpoints.mockResolvedValue([CDN]);
    answers.set(CDN, { ip: CLIENT });
    const baseline = await captureBaselineIp();

    await expect(verifyEgress(baseline)).resolves.toEqual({
      state: "bypassingTunnel",
      exitIp: CLIENT,
    });
  });

  it("refuses to compare two readings taken through different endpoints", async () => {
    // The trap from HANDOVER-2026-08-22 §6 item 4, driven end to end.
    //
    // The baseline is taken while the CDN is reachable, so it records
    // the customer's real address. By the time the after-reading is
    // taken the CDN no longer answers -- a censored network, or simply
    // the tunnel being down -- and the fallback list moves on to a node
    // mirror, which reports *the node's own address* because Cloudflare
    // rewrote the forwarded-for chain.
    //
    // Two honest answers to two different questions. The address is
    // different, so the old rule concluded "throughTunnel" and the
    // customer was told they were protected on the strength of a
    // comparison that measured nothing. Nothing about the route changed
    // between the two readings.
    endpoints.mockResolvedValue([CDN, FI_MIRROR]);
    answers.set(CDN, { ip: CLIENT });
    const baseline = await captureBaselineIp();
    expect(baseline).toEqual({ ip: CLIENT, from: CDN });

    answers.set(CDN, "unreachable");
    answers.set(FI_MIRROR, { ip: NODE });

    const verdict = await verifyEgress(baseline);
    expect(verdict).toEqual({ state: "indeterminate", exitIp: NODE });

    // Control: the shipped rule kept only the address, so this pair --
    // the exact pair measured on turkey-1 -- was indistinguishable from
    // a working tunnel.
    const asShipped = baseline!.ip === NODE ? "bypassingTunnel" : "throughTunnel";
    expect(asShipped).toBe("throughTunnel");
  });

  it("refuses in the other direction too, where the old rule cried wolf", async () => {
    // The mirror answered first for the baseline and the CDN answers
    // now. Same node address both sides of a real tunnel would read as
    // a leak under a bare comparison; here there is simply no comparison
    // to make.
    endpoints.mockResolvedValue([CDN, FI_MIRROR]);
    answers.set(CDN, "unreachable");
    answers.set(FI_MIRROR, { ip: NODE });
    const baseline = await captureBaselineIp();
    expect(baseline).toEqual({ ip: NODE, from: FI_MIRROR });

    answers.set(CDN, { ip: NODE });
    await expect(verifyEgress(baseline)).resolves.toEqual({
      state: "indeterminate",
      exitIp: NODE,
    });
  });

  it("reports no baseline as no comparison rather than as a verdict", async () => {
    endpoints.mockResolvedValue([CDN]);
    answers.set(CDN, { ip: CLIENT });
    await expect(verifyEgress(null)).resolves.toEqual({
      state: "indeterminate",
      exitIp: CLIENT,
    });
  });

  it("reports nothing answering as unreachable, not as a comparison", async () => {
    endpoints.mockResolvedValue([CDN, FI_MIRROR]);
    const baseline = { ip: CLIENT, from: CDN };
    await expect(verifyEgress(baseline)).resolves.toEqual({ state: "unreachable" });
  });

  it("records which endpoint answered, so the pair can be checked at all", async () => {
    // The load-bearing part, asserted directly. Without it the guard
    // above has nothing to compare and this whole file is decoration.
    endpoints.mockResolvedValue([CDN, FI_MIRROR]);
    answers.set(CDN, "unreachable");
    answers.set(FI_MIRROR, { ip: NODE });
    await expect(captureBaselineIp()).resolves.toEqual({ ip: NODE, from: FI_MIRROR });
  });

  it("gives up and reports no baseline when the whole list is dead", async () => {
    endpoints.mockResolvedValue([CDN, FI_MIRROR]);
    await expect(captureBaselineIp()).resolves.toBeNull();
  });
});

describe("the check made while a tunnel is coming up", () => {
  /** A third endpoint, so the measured order -- first fails, second
   * hangs, third answers -- can be laid out exactly. */
  const FR_MIRROR = "https://fr1.neoxify.site:2053/api";

  it("asks the baseline's endpoint alone, wherever it sits in the list", async () => {
    endpoints.mockResolvedValue([CDN, FI_MIRROR]);
    answers.set(CDN, "hang");
    answers.set(FI_MIRROR, { ip: "203.0.113.10" });
    const baseline = { ip: CLIENT, from: FI_MIRROR };

    await expect(verifyEgress(baseline, { sameEndpointOnly: true })).resolves.toEqual({
      state: "throughTunnel",
      exitIp: "203.0.113.10",
    });
    expect(asked).toEqual([FI_MIRROR]);
  });

  it("keeps the list order otherwise, so a mirror cannot accuse itself", async () => {
    // The reason the reordering is limited to `sameEndpointOnly`. This
    // mirror reports its own node's address to everyone, so a baseline
    // taken from it and a reading taken from it again are the same
    // number whatever the route did -- read as a leak. In list order the
    // CDN answers and the pair is, correctly, not compared at all.
    endpoints.mockResolvedValue([CDN, FI_MIRROR]);
    answers.set(CDN, { ip: NODE });
    answers.set(FI_MIRROR, { ip: NODE });
    const baseline = { ip: NODE, from: FI_MIRROR };

    await expect(verifyEgress(baseline)).resolves.toEqual({
      state: "indeterminate",
      exitIp: NODE,
    });
    expect(asked).toEqual([CDN]);
  });

  it("asks nothing but the baseline's endpoint when told to", async () => {
    // The measured failure, laid out as it happened on OpenVPN's first
    // seconds: the baseline's endpoint refused at once, the next one
    // hung for the full timeout, the third answered from the wrong
    // endpoint. Without `sameEndpointOnly` all of that time is spent on
    // an answer that cannot be used while another rung is waiting.
    endpoints.mockResolvedValue([CDN, FI_MIRROR, FR_MIRROR]);
    answers.set(CDN, "unreachable");
    answers.set(FI_MIRROR, "hang");
    answers.set(FR_MIRROR, { ip: NODE });
    const baseline = { ip: CLIENT, from: CDN };

    const started = Date.now();
    await expect(
      verifyEgress(baseline, { sameEndpointOnly: true, attemptMs: 5_000 }),
    ).resolves.toEqual({ state: "unreachable" });
    expect(asked).toEqual([CDN]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("abandons a request that hangs once its attempt time is up", async () => {
    endpoints.mockResolvedValue([CDN, FI_MIRROR, FR_MIRROR]);
    answers.set(CDN, "unreachable");
    answers.set(FI_MIRROR, "hang");
    answers.set(FR_MIRROR, { ip: NODE });
    const baseline = { ip: CLIENT, from: CDN };

    const started = Date.now();
    const verdict = await verifyEgress(baseline, { attemptMs: 50 });
    expect(Date.now() - started).toBeLessThan(1_000);
    // The fallback still runs where it is allowed, and still refuses to
    // turn a different endpoint's answer into a verdict.
    expect(verdict).toEqual({ state: "indeterminate", exitIp: NODE });
    expect(asked).toEqual([CDN, FI_MIRROR, FR_MIRROR]);
  });

  it("does not let a stalled request hide the one made after it", async () => {
    // The first-connect OpenVPN case, measured: the request made the
    // moment the tunnel came up stalls for longer than the whole check,
    // while one made a second or two later is answered through the
    // node. Asked in sequence, the stalled one was the entire check.
    endpoints.mockResolvedValue([CDN]);
    scripts.set(CDN, ["hang", "unreachable"]);
    answers.set(CDN, { ip: NODE });
    const baseline = { ip: CLIENT, from: CDN };

    const started = Date.now();
    await expect(
      confirmEgressWithin(baseline, 5_000, { sameEndpointOnly: true, intervalMs: 20 }),
    ).resolves.toEqual({ state: "throughTunnel", exitIp: NODE });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(asked.length).toBeGreaterThanOrEqual(3);
  });

  it("gives the latest answer when no proof arrives in time", async () => {
    endpoints.mockResolvedValue([CDN]);
    answers.set(CDN, { ip: CLIENT });
    const baseline = { ip: CLIENT, from: CDN };

    await expect(
      confirmEgressWithin(baseline, 100, { sameEndpointOnly: true, intervalMs: 20 }),
    ).resolves.toEqual({ state: "bypassingTunnel", exitIp: CLIENT });
  });

  it("reports unreachable, on time, when every request stalls", async () => {
    endpoints.mockResolvedValue([CDN]);
    answers.set(CDN, "hang");
    const baseline = { ip: CLIENT, from: CDN };

    const started = Date.now();
    await expect(
      confirmEgressWithin(baseline, 150, { sameEndpointOnly: true, intervalMs: 20 }),
    ).resolves.toEqual({ state: "unreachable" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
