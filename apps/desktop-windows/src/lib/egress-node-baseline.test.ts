import { afterEach, describe, expect, it, vi } from "vitest";

/** A baseline is the address this device has with no tunnel up, and one
 * of our nodes' addresses never is that.
 *
 * A node mirror whose nginx proxies through the CDN answers `/health/ip`
 * with the node's own address to everyone (five of six mirrors did, on
 * 2026-08-31; the installer still builds one that way without
 * NEOXIFY_PANEL_ORIGIN). On a network where the CDN is blocked such a
 * mirror supplies the baseline, and through a working tunnel the same
 * mirror gives the same address back: `bypassingTunnel`, a false leak.
 * `BaselineOptions.nodeAddresses` passes those readings over. The
 * addresses are RFC 5737 stand-ins; see docs/node-address-hygiene.md. */

const endpoints = vi.fn<() => Promise<string[]>>();
vi.mock("./api-endpoints", () => ({ apiEndpoints: () => endpoints() }));

const remembered: unknown[] = [];
vi.mock("./network-identity", () => ({ rememberNetwork: (body: unknown) => remembered.push(body) }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("not registered")) }));

/** What each base answers; a base missing from the map is unreachable. */
const answers = new Map<string, string>();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string) => {
    const ip = answers.get(url.replace(/\/health\/ip$/, ""));
    if (ip === undefined) return Promise.reject(new Error("no route"));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ip, asn: 64500 }) });
  },
}));

const { captureBaselineIp, verifyEgress } = await import("./egress");

const CDN = "https://connect.example.test/api";
const SELF_REPORTING = "https://node-a.example.test:2053/api";
const HONEST = "https://node-b.example.test:2053/api";
/** The customer's own line. */
const CLIENT = "192.0.2.228";
/** Node A's address, which its mirror reports to everyone. */
const NODE_A = "203.0.113.20";

afterEach(() => {
  endpoints.mockReset();
  answers.clear();
  remembered.length = 0;
});

describe("a baseline that is one of our nodes' addresses", () => {
  it("is what the egress check compared against before, and read a working tunnel as a leak", async () => {
    // The control: no `nodeAddresses`, as every caller was. The CDN is
    // blocked on the bare network, so the self-reporting mirror answers.
    endpoints.mockResolvedValue([CDN, SELF_REPORTING]);
    answers.set(SELF_REPORTING, NODE_A);
    const baseline = await captureBaselineIp();
    expect(baseline).toEqual({ ip: NODE_A, from: SELF_REPORTING });
    // Through a working tunnel, asked of the baseline's endpoint only --
    // the ladder's non-last rungs, the mobile health poll.
    await expect(verifyEgress(baseline, { sameEndpointOnly: true })).resolves.toEqual({
      state: "bypassingTunnel",
      exitIp: NODE_A,
    });
  });

  it("is passed over, and the next endpoint asked", async () => {
    endpoints.mockResolvedValue([CDN, SELF_REPORTING, HONEST]);
    answers.set(SELF_REPORTING, NODE_A);
    answers.set(HONEST, CLIENT);
    await expect(captureBaselineIp({ nodeAddresses: [NODE_A] })).resolves.toEqual({ ip: CLIENT, from: HONEST });
    // What the node's mirror said about the network is the node's, not
    // the customer's, and is not kept.
    expect(remembered).toEqual([{ ip: CLIENT, asn: 64500 }]);
  });

  it("leaves no baseline when nothing else answered", async () => {
    endpoints.mockResolvedValue([CDN, SELF_REPORTING]);
    answers.set(SELF_REPORTING, NODE_A);
    await expect(captureBaselineIp({ nodeAddresses: new Set([NODE_A]) })).resolves.toBeNull();
    expect(remembered).toEqual([]);
  });

  it("matches the address however the server writes it", async () => {
    endpoints.mockResolvedValue([SELF_REPORTING]);
    answers.set(SELF_REPORTING, `::ffff:${NODE_A}`);
    await expect(captureBaselineIp({ nodeAddresses: [` ${NODE_A} `] })).resolves.toBeNull();

    answers.set(SELF_REPORTING, "2001:db8::a");
    await expect(captureBaselineIp({ nodeAddresses: ["2001:DB8::A"] })).resolves.toBeNull();
  });

  it("changes nothing for an address that is not one of ours", async () => {
    endpoints.mockResolvedValue([CDN]);
    answers.set(CDN, CLIENT);
    await expect(captureBaselineIp({ nodeAddresses: [NODE_A] })).resolves.toEqual({ ip: CLIENT, from: CDN });
    await expect(captureBaselineIp({ only: CDN, nodeAddresses: [] })).resolves.toEqual({ ip: CLIENT, from: CDN });
  });
});
