import type { InsightCredentials, InsightNetwork } from "./customer-insight.types";
import { findingsFor, type FindingsInput } from "./insight-findings";

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const DAY = 86_400_000;

const sub = (over: Partial<InsightCredentials> = {}): InsightCredentials => ({
  subscriptionId: "sub-1",
  planName: "Pro",
  status: "ACTIVE",
  startAt: new Date(NOW - 10 * DAY).toISOString(),
  expireAt: new Date(NOW + 20 * DAY).toISOString(),
  dataCapBytes: null,
  dataUsedBytes: "0",
  total: 4,
  active: 4,
  notProvisioned: 0,
  held: 0,
  perDevice: 0,
  byProtocol: [],
  ...over,
});

const net = (over: Partial<InsightNetwork> = {}): InsightNetwork => ({
  asn: 64500,
  name: "Example Net",
  country: "ZZ",
  tried: 0,
  succeeded: 0,
  apiUnreachable: 0,
  lastAt: null,
  lastSuccessAt: null,
  others: null,
  ...over,
});

/** A customer with nothing wrong: 10 of 10 on one network, a live plan. */
const healthy = (over: Partial<FindingsInput> = {}): FindingsInput => ({
  now: NOW,
  windowDays: 7,
  emailVerifiedAt: new Date(NOW - 30 * DAY).toISOString(),
  apps: [{ platform: "windows", appVersion: "0.9.57", lastSeenAt: new Date(NOW).toISOString(), latestVersion: "0.9.57", behind: false }],
  tried: 10,
  succeeded: 10,
  networks: [net({ tried: 10, succeeded: 10 })],
  failures: [],
  credentials: [sub()],
  vouchers: [],
  lastReport: { at: new Date(NOW).toISOString(), category: "connect" },
  ...over,
});

const codes = (input: FindingsInput) => findingsFor(input).map((f) => f.code);
const find = (input: FindingsInput, code: string) => findingsFor(input).find((f) => f.code === code);

describe("findingsFor", () => {
  it("a healthy customer: HEALTHY and no problem", () => {
    const findings = findingsFor(healthy());
    expect(findings.map((f) => f.code)).toEqual(["HEALTHY"]);
    expect(findings[0].detail).toBe("10 of 10 connection attempts in the last 7 days succeeded.");
  });

  it("NEVER_CONNECTED, with the counts", () => {
    const f = find(healthy({ succeeded: 0, tried: 4, networks: [net({ tried: 4 })] }), "NEVER_CONNECTED");
    expect(f).toMatchObject({ severity: "problem", detail: "0 of 4 connection attempts in the last 7 days succeeded." });
  });

  it("NO_ATTEMPTS says when the last report of any kind was", () => {
    const f = find(healthy({ tried: 0, succeeded: 0, lastReport: { at: "2026-11-01T00:00:00.000Z", category: "api" } }), "NO_ATTEMPTS");
    expect(f?.detail).toContain("2026-11-01T00:00:00.000Z (api)");
    expect(find(healthy({ tried: 0, succeeded: 0, lastReport: null }), "NO_ATTEMPTS")?.detail).toContain("no report");
  });

  it("NETWORK_SPECIFIC names the failing and the working network", () => {
    const f = find(
      healthy({
        tried: 6,
        succeeded: 3,
        networks: [net({ asn: 64500, name: "Bad Net", tried: 3 }), net({ asn: 64501, name: "Good Net", tried: 3, succeeded: 3 })],
      }),
      "NETWORK_SPECIFIC",
    );
    expect(f?.detail).toBe("0 of 3 connection attempts succeeded on Bad Net (AS64500); 3 of 3 succeeded on Good Net (AS64501).");
    // One failed try is not enough.
    expect(codes(healthy({ networks: [net({ tried: 1 }), net({ asn: 64501, tried: 3, succeeded: 3 })] }))).not.toContain("NETWORK_SPECIFIC");
  });

  it("NETWORK_OTHERS_OK when most others on the network connect", () => {
    const input = healthy({ tried: 2, succeeded: 0, networks: [net({ tried: 2, others: { customers: 5, connected: 4, hours: 48 } })] });
    const f = find(input, "NETWORK_OTHERS_OK");
    expect(f?.detail).toContain("4 of 5 other customers");
    expect(f?.detail).toContain("0 of 2 attempts");
    expect(codes(input)).not.toContain("NETWORK_OTHERS_FAIL");
  });

  it("NETWORK_OTHERS_FAIL when few others connect either, and nothing in between", () => {
    expect(codes(healthy({ tried: 2, succeeded: 0, networks: [net({ tried: 2, others: { customers: 8, connected: 2, hours: 48 } })] }))).toContain(
      "NETWORK_OTHERS_FAIL",
    );
    const middle = codes(healthy({ tried: 2, succeeded: 0, networks: [net({ tried: 2, others: { customers: 10, connected: 5, hours: 48 } })] }));
    expect(middle).not.toContain("NETWORK_OTHERS_OK");
    expect(middle).not.toContain("NETWORK_OTHERS_FAIL");
  });

  it("API_UNREACHABLE_OFTEN at three, naming the networks", () => {
    const f = find(healthy({ networks: [net({ tried: 10, succeeded: 10, apiUnreachable: 2 }), net({ asn: null, name: null, apiUnreachable: 1 })] }), "API_UNREACHABLE_OFTEN");
    expect(f?.detail).toBe("3 background reports in the last 7 days could not reach the API: 2 on Example Net (AS64500), 1 on an unknown network.");
    expect(codes(healthy({ networks: [net({ tried: 10, succeeded: 10, apiUnreachable: 2 })] }))).not.toContain("API_UNREACHABLE_OFTEN");
  });

  const failure = (code: string, count: number) => ({ code: code as never, label: "", count, lastAt: "", example: "" });

  it("NOT_CARRYING_OFTEN at three", () => {
    expect(codes(healthy({ failures: [failure("NOT_CARRYING", 3)] }))).toContain("NOT_CARRYING_OFTEN");
    expect(codes(healthy({ failures: [failure("NOT_CARRYING", 2)] }))).not.toContain("NOT_CARRYING_OFTEN");
    expect(find(healthy({ failures: [failure("NOT_CARRYING", 3)] }), "NOT_CARRYING_OFTEN")?.title).toBe("Tunnels came up but carried nothing");
  });

  it("NOT_CARRYING_OFTEN counting the outcome-only cause does not claim the tunnels came up", () => {
    const f = find(healthy({ failures: [failure("NOT_CARRYING", 1), failure("NO_HANDSHAKE_OR_TRAFFIC", 2)] }), "NOT_CARRYING_OFTEN");
    expect(f?.title).toBe("Tunnels did not complete a handshake or carried nothing");
    expect(f?.detail).toContain("1 known to have come up and carried nothing; for 2 the app did not say which");
  });

  it("SERVICE_NOT_ANSWERING is a problem, so HEALTHY is not said", () => {
    const c = codes(healthy({ failures: [failure("SERVICE_NOT_ANSWERING", 1)] }));
    expect(c).toContain("SERVICE_NOT_ANSWERING");
    expect(c).not.toContain("HEALTHY");
  });

  it("OTHER_VPN", () => {
    expect(find(healthy({ failures: [failure("OTHER_VPN_ACTIVE", 2)] }), "OTHER_VPN")?.detail).toContain("2 reports");
  });

  it("APP_BEHIND only when behind is true", () => {
    const behind = healthy({ apps: [{ platform: "android", appVersion: "0.2.30", lastSeenAt: "x", latestVersion: "0.2.35", behind: true }] });
    expect(find(behind, "APP_BEHIND")?.detail).toContain("0.2.30; the newest release is 0.2.35");
    expect(codes(healthy({ apps: [{ platform: "ios", appVersion: "0.2.30", lastSeenAt: "x", latestVersion: null, behind: null }] }))).not.toContain("APP_BEHIND");
  });

  it("EMAIL_UNVERIFIED", () => {
    expect(codes(healthy({ emailVerifiedAt: null }))).toContain("EMAIL_UNVERIFIED");
  });

  it("NO_ACTIVE_PLAN when there is no subscription or none is live", () => {
    expect(find(healthy({ credentials: [] }), "NO_ACTIVE_PLAN")?.detail).toBe("The customer has no subscription.");
    expect(codes(healthy({ credentials: [sub({ status: "PENDING" })] }))).toContain("NO_ACTIVE_PLAN");
  });

  it("PLAN_EXPIRED when the newest subscription's expiry has passed", () => {
    const c = codes(healthy({ credentials: [sub({ status: "EXPIRED", expireAt: new Date(NOW - DAY).toISOString() })] }));
    expect(c).toContain("PLAN_EXPIRED");
    expect(c).not.toContain("NO_ACTIVE_PLAN");
    expect(codes(healthy({ credentials: [sub({ status: "ACTIVE", expireAt: new Date(NOW - DAY).toISOString() })] }))).toContain("PLAN_EXPIRED");
  });

  it("DATA_CAP_REACHED on a live plan", () => {
    expect(find(healthy({ credentials: [sub({ dataCapBytes: "1000", dataUsedBytes: "1000" })] }), "DATA_CAP_REACHED")?.detail).toBe(
      "Pro: 1000 of 1000 bytes used.",
    );
    expect(codes(healthy({ credentials: [sub({ dataCapBytes: "1000", dataUsedBytes: "999" })] }))).not.toContain("DATA_CAP_REACHED");
  });

  it("CREDENTIALS_NOT_PROVISIONED on a live plan", () => {
    expect(find(healthy({ credentials: [sub({ notProvisioned: 2 })] }), "CREDENTIALS_NOT_PROVISIONED")?.detail).toContain("2 of 4");
  });

  it("CODE_USED_ELSEWHERE only when this account has not redeemed it", () => {
    const voucher = (sameAccount: boolean[]) => ({
      voucherId: "v-1",
      planName: "Pro",
      issuedAt: "2026-11-01T00:00:00.000Z",
      issuedByEmail: null,
      issuedToThisEmail: true,
      maxRedemptions: 1,
      redeemedCount: sameAccount.length,
      redemptions: sameAccount.map((same) => ({ redeemedAt: "x", customerId: same ? "me" : "other", sameAccount: same, subscriptionId: null })),
    });
    expect(codes(healthy({ vouchers: [voucher([false])] }))).toContain("CODE_USED_ELSEWHERE");
    expect(codes(healthy({ vouchers: [voucher([false, true])] }))).not.toContain("CODE_USED_ELSEWHERE");
    expect(codes(healthy({ vouchers: [voucher([])] }))).not.toContain("CODE_USED_ELSEWHERE");
  });

  it("HEALTHY needs three attempts and nine in ten", () => {
    expect(codes(healthy({ tried: 2, succeeded: 2 }))).not.toContain("HEALTHY");
    expect(codes(healthy({ tried: 10, succeeded: 8 }))).not.toContain("HEALTHY");
  });

  it("orders problems before warnings before info", () => {
    const severities = findingsFor(healthy({ emailVerifiedAt: null, credentials: [], tried: 0, succeeded: 0 })).map((f) => f.severity);
    expect(severities).toEqual([...severities].sort((a, b) => ["problem", "warning", "info"].indexOf(a) - ["problem", "warning", "info"].indexOf(b)));
  });
});
