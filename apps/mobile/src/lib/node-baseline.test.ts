import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/** A censored network, a node mirror that reports its own node's
 * address, and a tunnel that works -- through the real shared egress
 * check and these rules, with only the network stood in for.
 *
 * Before connecting, the CDN is blocked, so the baseline comes from a
 * node mirror. One installed without NEOXIFY_PANEL_ORIGIN proxies
 * through the CDN and answers every caller with its node's address. Kept
 * as the "before", that address came back again through the working
 * tunnel whenever the same mirror was asked -- which the ladder's earlier
 * rungs and the health poll do -- and read as `bypassingTunnel`: the rung
 * torn down and remembered as failing on this network, the poll showing
 * "Your traffic is NOT protected". The dashboard now passes our nodes'
 * addresses to every baseline, and such a reading is passed over.
 *
 * Whether any live mirror is in that state is not known from here; five
 * of six were on 2026-08-31. Addresses are RFC 5737 stand-ins. */

const CDN = "https://api.example.test";
const SELF_REPORTING = "https://node-a.example.test:2053/api";
const HONEST = "https://node-b.example.test:2053/api";
const PHONE = "192.0.2.44";
const NODE_A = "203.0.113.20";
const NODE_B = "203.0.113.30";
const EXIT = "203.0.113.9";

let endpoints: string[] = [];
let tunnelUp = false;

vi.mock("@shared/lib/api-endpoints", () => ({ apiEndpoints: async () => endpoints }));
vi.mock("@shared/lib/network-identity", () => ({ rememberNetwork: () => undefined }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("not registered")) }));
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: async (url: string) => {
    const base = url.replace(/\/health\/ip$/, "");
    // Blocked on the bare network; reachable through the tunnel.
    if (base === CDN && !tunnelUp) throw new Error("blocked");
    const ip = base === SELF_REPORTING ? NODE_A : tunnelUp ? EXIT : PHONE;
    return { ok: true, status: 200, json: async () => ({ ip }) };
  },
}));

const { captureBaselineIp } = await import("@shared/lib/egress");
const { confirmEgress, nodeAddressesOf, pollEgress, pollState, rejectionIsEvidence, rungOutcome } = await import(
  "./tunnel-evidence"
);

/** The account's credentials, as the server sends them: each one's
 * `connection.host` is its node's public address. */
const USERS = [
  { connection: { host: NODE_A, port: 2053 } },
  { connection: { host: NODE_B, port: 2053 } },
  { connection: { host: NODE_A, port: 443 } },
];

const quick = { intervalMs: 5, timeoutMs: 40 };

afterEach(() => {
  tunnelUp = false;
});

describe("nodeAddressesOf", () => {
  it("collects each credential's node address once", () => {
    expect(nodeAddressesOf(USERS)).toEqual(new Set([NODE_A, NODE_B]));
  });

  it("skips a credential with no connection", () => {
    expect(nodeAddressesOf([{ connection: null }, {}, { connection: { host: " " } }])).toEqual(new Set());
  });
});

describe("a self-reporting mirror before connecting", () => {
  it("made a working tunnel read as a leak when its answer was the baseline", async () => {
    // The control: the baseline as it was taken, with nothing passed.
    endpoints = [CDN, SELF_REPORTING];
    const baseline = await captureBaselineIp();
    expect(baseline).toEqual({ ip: NODE_A, from: SELF_REPORTING });

    tunnelUp = true;
    const verdict = await confirmEgress(baseline, { ...quick, sameEndpointOnly: true });
    expect(verdict?.state).toBe("bypassingTunnel");
    expect(rungOutcome(verdict!, { baselineTaken: true, isLast: false })).toBe("notCarrying");
    expect(rejectionIsEvidence(verdict!)).toBe(true);
    expect(pollState("unverified", await pollEgress(baseline))).toBe("degraded");
  });

  it("is not a baseline, so a working tunnel lands unproven rather than accused", async () => {
    endpoints = [CDN, SELF_REPORTING];
    const baseline = await captureBaselineIp({ nodeAddresses: nodeAddressesOf(USERS) });
    expect(baseline).toBeNull();

    tunnelUp = true;
    const verdict = await confirmEgress(baseline, { ...quick, sameEndpointOnly: true });
    expect(verdict?.state).toBe("indeterminate");
    // No baseline: the first rung lands, "Connected, not confirmed", and
    // nothing is held against the route.
    expect(rungOutcome(verdict!, { baselineTaken: false, isLast: false })).toBe("unverified");
    expect(rejectionIsEvidence(verdict!)).toBe(false);
    expect(pollState("unverified", await pollEgress(baseline))).toBe("unverified");
  });

  it("gives way to a mirror that reports the phone, and the tunnel is proven", async () => {
    endpoints = [CDN, SELF_REPORTING, HONEST];
    const baseline = await captureBaselineIp({ nodeAddresses: nodeAddressesOf(USERS) });
    expect(baseline).toEqual({ ip: PHONE, from: HONEST });

    tunnelUp = true;
    const verdict = await confirmEgress(baseline, { ...quick, sameEndpointOnly: true });
    expect(verdict).toEqual({ state: "throughTunnel", exitIp: EXIT });
    expect(rungOutcome(verdict!, { baselineTaken: true, isLast: false })).toBe("connected");
    expect(pollState("unverified", await pollEgress(baseline))).toBe("connected");
  });
});

describe("the dashboard", () => {
  it("passes our nodes' addresses to every baseline it takes", () => {
    const source = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
    // Every one through `takeBaseline`, which puts a ceiling on it
    // (own-mirror.test.ts): the screen-load baseline, the ladder's first,
    // the first rung's retake, and each rung's after a teardown.
    expect(source).not.toContain("captureBaselineIp(");
    const calls = [...source.matchAll(/takeBaseline\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls).toHaveLength(4);
    for (const args of calls) expect(args).toContain("nodeAddresses");
  });
});
