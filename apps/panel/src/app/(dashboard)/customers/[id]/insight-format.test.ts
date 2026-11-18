import { describe, expect, it } from "vitest";
import type { CustomerAttemptDetail, InsightCredentials } from "@/lib/types";
import {
  attemptsQuery,
  credentialLine,
  customerHref,
  hasFilters,
  othersLine,
  parseAttemptFilters,
  parseDays,
  parseHours,
  parseView,
  supportText,
  timesDiffer,
} from "./insight-format";

const ID = "00000000-0000-4000-8000-000000000001";

function attempt(over: Partial<CustomerAttemptDetail> = {}): CustomerAttemptDetail {
  return {
    id: "a1",
    at: "2026-11-18T10:00:00.000Z",
    kind: "CONNECT",
    outcome: "NOT_CARRYING_TRAFFIC",
    platform: "windows",
    appVersion: "0.9.57",
    network: { asn: 64500, name: "Example Net" },
    ip: "192.0.2.10",
    throughServer: null,
    noAddress: null,
    server: null,
    protocol: null,
    reason: "up but unreachable",
    sessionSeconds: null,
    rungs: [
      {
        protocol: "XRAY_VLESS_REALITY",
        result: "not carrying traffic",
        server: "example-1",
        carried: false,
        downKbps: null,
        upKbps: null,
      } as CustomerAttemptDetail["rungs"][number],
    ],
    receivedAt: "2026-11-18T10:00:20.000Z",
    occurredAt: "2026-11-18T10:00:00.000Z",
    category: "connect",
    failureCode: "NOT_CARRYING",
    apiEndpoint: null,
    apiTrace: null,
    ...over,
  };
}

describe("query parsing", () => {
  it("falls back to the defaults for anything not on offer", () => {
    expect(parseView("usage")).toBe("usage");
    expect(parseView("nope")).toBe("overview");
    expect(parseView(undefined)).toBe("overview");
    expect(parseDays("30")).toBe(30);
    expect(parseDays("5")).toBe(7);
    expect(parseHours("336")).toBe(336);
    expect(parseHours("abc")).toBe(72);
  });

  it("keeps only filter values the backend accepts", () => {
    const filters = parseAttemptFilters({
      kind: "CONNECT",
      outcome: "BOGUS",
      category: "api",
      failureCode: "NOT_A_CODE",
      platform: "windows",
      asn: "64500abc",
      q: "  timed out  ",
    });
    expect(filters).toEqual({ kind: "CONNECT", category: "api", platform: "windows", q: "timed out" });
    expect(hasFilters(filters)).toBe(true);
    expect(hasFilters(parseAttemptFilters({ kind: "", q: "   " }))).toBe(false);
    expect(parseAttemptFilters({ asn: ["64500", "1"] }).asn).toBe("64500");
  });

  it("builds the attempts query with the window", () => {
    expect(attemptsQuery({ outcome: "SUCCESS", asn: "64500" }, 50, 0)).toBe("outcome=SUCCESS&asn=64500&take=50");
    expect(attemptsQuery({ q: "a b&c" }, 50, 100)).toBe("q=a+b%26c&take=50&skip=100");
  });

  it("leaves defaults and empties out of page links", () => {
    expect(customerHref(ID, { view: "overview", days: 7 })).toBe(`/customers/${ID}`);
    expect(customerHref(ID, { view: "connections", days: 30, kind: undefined, q: "" })).toBe(
      `/customers/${ID}?view=connections&days=30`,
    );
    expect(customerHref(ID, { view: "usage", hours: 72 })).toBe(`/customers/${ID}?view=usage`);
  });
});

describe("lines beside the counts", () => {
  const creds = (over: Partial<InsightCredentials>): InsightCredentials => ({
    subscriptionId: "s1",
    planName: "Plan",
    status: "ACTIVE",
    startAt: "2026-11-01T00:00:00.000Z",
    expireAt: "2026-12-01T00:00:00.000Z",
    dataCapBytes: null,
    dataUsedBytes: "0",
    total: 64,
    active: 64,
    notProvisioned: 0,
    held: 0,
    perDevice: 0,
    byProtocol: [],
    ...over,
  });

  it("says whether credentials are on the servers", () => {
    expect(credentialLine(creds({}))).toBe("64 credentials, all on the servers");
    expect(credentialLine(creds({ notProvisioned: 3 }))).toBe("3 of 64 not yet on the servers");
    expect(credentialLine(creds({ held: 2 }))).toBe("64 credentials, all on the servers, 2 held by the device limit");
    expect(credentialLine(creds({ total: 1, active: 1 }))).toBe("1 credential, all on the servers");
    expect(credentialLine(creds({ total: 0 }))).toBe("No credentials");
  });

  it("compares with other customers only when there are enough", () => {
    expect(othersLine({ customers: 9, connected: 7, hours: 48 }, 2)).toBe("7 of 9 connected");
    expect(othersLine(null, 3)).toBe("too few to compare");
    expect(othersLine(null, 12)).toBe("too few to compare, or not compared");
  });
});

describe("copy for support", () => {
  it("describes the attempt without the customer's address", () => {
    const text = supportText(attempt());
    expect(text).toContain("Report a1");
    expect(text).toContain("Happened: 2026-11-18 10:00:00 UTC");
    expect(text).not.toContain("Received:");
    expect(text).toContain("Outcome: Tunnel carried nothing");
    expect(text).toContain("Cause: Tunnel came up but carried no traffic");
    expect(text).toContain("Network: Example Net AS64500");
    expect(text).toContain("1. example-1 Xray VLESS+REALITY: not carrying traffic, carried nothing");
    expect(text).not.toContain("192.0.2.10");
    expect(text).not.toContain("@");
  });

  it("adds the received time for a queued report and the API trace", () => {
    const text = supportText(
      attempt({
        outcome: "CONTROL_PLANE_UNREACHABLE",
        category: "api",
        failureCode: "API_UNREACHABLE",
        rungs: [],
        receivedAt: "2026-11-18T12:30:00.000Z",
        apiTrace: {
          entries: [{ leg: "req", target: "api.example.com:443", outcome: "timeout", ms: 8000 }],
          probe: "tcp api.example.com:443 timeout",
          noneDialled: false,
          cut: 2,
        },
      }),
    );
    expect(text).toContain("Received: 2026-11-18 12:30:00 UTC");
    expect(text).toContain("API trace:\n  req api.example.com:443 timeout 8000 ms\n  (2 more not kept)");
    expect(text).toContain("Probe: tcp api.example.com:443 timeout");
    expect(text).not.toContain("Tried, in order");
  });

  it("treats a gap of a minute or less as the same moment", () => {
    expect(timesDiffer(attempt({ receivedAt: "2026-11-18T10:01:00.000Z" }))).toBe(false);
    expect(timesDiffer(attempt({ receivedAt: "2026-11-18T10:01:01.000Z" }))).toBe(true);
    expect(timesDiffer(attempt({ occurredAt: null, receivedAt: "2026-11-18T10:05:00.000Z" }))).toBe(true);
  });
});
