import { afterEach, describe, expect, it, vi } from "vitest";

/** The endpoint list, stood in for so the fallback order can be driven
 * from a test without a Tauri store. */
const endpoints = vi.fn<() => Promise<string[]>>();
/** Every `/health/ip` answer, keyed by the base URL that would serve it.
 * A base missing from the map is treated as unreachable. */
const answers = new Map<string, { ip: string } | "unreachable">();

vi.mock("./api-endpoints", () => ({ apiEndpoints: () => endpoints() }));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string) => {
    const base = url.replace(/\/health\/ip$/, "");
    const answer = answers.get(base);
    if (answer === undefined || answer === "unreachable") {
      return Promise.reject(new Error(`no route to ${base}`));
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve(answer) });
  },
}));

// The IPv6 half of the module reaches for a Tauri command it has no
// business invoking here.
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("not used")) }));

const { captureBaselineIp, verifyEgress } = await import("./egress");

/** The real production list, in the real order (`config.ts`). The first
 * entry is the Cloudflare-fronted panel; the rest are node mirrors. */
const CDN = "https://connect.neoxify.site/api";
const FI_MIRROR = "https://fi1.neoxify.site:2053/api";

afterEach(() => {
  endpoints.mockReset();
  answers.clear();
});

/** The client's real address, as the CDN reports it. */
const CLIENT = "50.34.35.228";
/** A node's own address, as a mirror with a broken `X-Forwarded-For`
 * chain reports it -- measured on turkey-1, where the mirror proxies to
 * the Cloudflare-fronted panel and Cloudflare overwrites
 * `cf-connecting-ip` with the node. */
const NODE = "130.94.0.27";

describe("comparing the address the world sees", () => {
  it("calls a changed address through the same endpoint proof", async () => {
    endpoints.mockResolvedValue([CDN]);
    answers.set(CDN, { ip: CLIENT });
    const baseline = await captureBaselineIp();

    answers.set(CDN, { ip: "38.60.249.229" });
    await expect(verifyEgress(baseline)).resolves.toEqual({
      state: "throughTunnel",
      exitIp: "38.60.249.229",
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
