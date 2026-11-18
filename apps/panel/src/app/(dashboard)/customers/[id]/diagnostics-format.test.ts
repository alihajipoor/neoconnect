import { describe, expect, it } from "vitest";
import type { InsightDeviceFacts, InsightServiceChecks, InsightServiceResult } from "@/lib/types";
import {
  bytesText,
  dataCheckLegText,
  detailFactGroups,
  deviceFactsLine,
  addressKindText,
  resolvedText,
  diagnosticsApiPath,
  diagnosticsHref,
  lookupReference,
  egressText,
  factsByDevice,
  lastRunCounts,
  lastRunRoute,
  msText,
  parseReference,
  platformName,
  reconnectText,
  referenceFromLink,
  routeGroupLabel,
  sessionEndText,
  utcStamp,
  viaText,
} from "./diagnostics-format";

const ID = "00000000-0000-4000-8000-000000000001";

function facts(over: Partial<InsightDeviceFacts> = {}): InsightDeviceFacts {
  return { sessionId: null, platform: "android", label: null, lastSeenAt: "2026-11-18T10:00:00.000Z", device: null, net: null, tunnel: null, ...over };
}

function result(over: Partial<InsightServiceResult> = {}): InsightServiceResult {
  return {
    key: "google",
    label: "Google",
    host: "www.google.com",
    ok: true,
    stage: "ok",
    dnsMs: 30,
    connectMs: 90,
    tlsMs: 200,
    firstByteMs: 300,
    status: 204,
    address: "198.51.100.4",
    addressKind: "public",
    error: null,
    at: "2026-11-18T10:00:00.000Z",
    server: "exit-1",
    protocol: "XRAY_VLESS_REALITY",
    via: "tunnel",
    ...over,
  };
}

describe("numbers and times", () => {
  it("says milliseconds and seconds", () => {
    expect(msText(840)).toBe("840 ms");
    expect(msText(4200)).toBe("4.2 s");
    expect(msText(38_400)).toBe("38 s");
    expect(msText(null)).toBeNull();
    expect(msText(undefined)).toBeNull();
  });

  it("says bytes", () => {
    expect(bytesText(512)).toBe("512 B");
    expect(bytesText(49_152)).toBe("48 KB");
    expect(bytesText(1_258_291)).toBe("1.2 MB");
  });

  it("gives the exact time in UTC", () => {
    expect(utcStamp("2026-11-18T19:45:10.000Z")).toBe("18 Nov 19:45 UTC");
    expect(utcStamp("nonsense")).toBe("nonsense");
  });

  it("names platforms and keeps unknown ones", () => {
    expect(platformName("android")).toBe("Android");
    expect(platformName("ios")).toBe("iOS");
    expect(platformName("haiku")).toBe("haiku");
    expect(platformName(null)).toBeNull();
  });
});

describe("device facts", () => {
  it("builds the short line from only what was reported", () => {
    const line = deviceFactsLine(
      facts({
        device: { model: "SM-S918B", os: "android", osVersion: "14", language: "fa", lowPower: true, dataSaver: false },
        net: { type: "cellular", metered: true, dns: ["192.0.2.53", "192.0.2.54"], privateDns: "host", privateDnsHost: "dns.example.net", otherVpn: false },
        tunnel: { mode: "gaming" },
      }),
    );
    expect(line).toEqual([
      "SM-S918B",
      "Android 14",
      "language fa",
      "Mobile data, metered",
      "DNS 192.0.2.53, 192.0.2.54",
      "Private DNS dns.example.net",
      "battery saver on",
      "VPN mode gaming",
    ]);
  });

  it("is empty when nothing was reported", () => {
    expect(deviceFactsLine(facts())).toEqual([]);
  });

  it("says the Private DNS mode when no host is set, and flags another VPN", () => {
    const line = deviceFactsLine(facts({ net: { type: "wifi", metered: false, privateDns: "auto", otherVpn: true } }));
    expect(line).toEqual(["Wi-Fi, not metered", "Private DNS automatic", "another VPN active"]);
  });

  it("groups labelled facts and leaves empty groups out", () => {
    const groups = detailFactGroups({
      net: { type: "wifi", otherVpn: true, dns: ["2001:db8::53"] },
      tunnel: { dnsUnprotected: true, splitTunnel: false },
    });
    expect(groups.map((g) => g.title)).toEqual(["Network", "VPN settings"]);
    expect(groups[0].facts).toEqual([
      { label: "Network", value: "Wi-Fi" },
      { label: "Another VPN active", value: "yes", warn: true },
      { label: "Device DNS", value: "2001:db8::53" },
    ]);
    expect(groups[1].facts).toEqual([
      { label: "Split tunnel", value: "no" },
      { label: "DNS outside the VPN", value: "yes", warn: true },
    ]);
    expect(detailFactGroups(null)).toEqual([]);
    expect(detailFactGroups({})).toEqual([]);
  });

  it("matches facts to listed devices and groups the rest by platform", () => {
    const listed = facts({ sessionId: "s1" });
    const gone = facts({ sessionId: "s9", platform: "Windows", lastSeenAt: "2026-11-17T00:00:00.000Z" });
    const noSession = facts({ platform: "windows", lastSeenAt: "2026-11-18T00:00:00.000Z" });
    const { bySession, unmatched } = factsByDevice([{ sessionId: "s1" }], [listed, gone, noSession]);
    expect(bySession.get("s1")).toBe(listed);
    expect(unmatched).toEqual([{ platform: "windows", facts: [noSession, gone] }]);
    expect(factsByDevice(null, undefined)).toEqual({ bySession: new Map(), unmatched: [] });
  });
});

describe("report details in words", () => {
  it("says the data check, exit check, reconnect and session end", () => {
    expect(dataCheckLegText({ status: "ok", bytes: 49_152, ms: 320 })).toBe("ok, 48 KB in 320 ms");
    expect(dataCheckLegText(undefined)).toBeNull();
    expect(egressText({ state: "ok", ms: 180 })).toBe("ok in 180 ms");
    expect(egressText({ state: "mismatch" })).toBe("mismatch");
    expect(reconnectText({ attempt: 3, quickDeaths: 1, spentMs: 41_200, droppedSecondsAgo: 95 })).toBe(
      "try 3, 1 quick drop, 41 s spent, dropped 1m before",
    );
    expect(reconnectText({})).toBeNull();
    expect(sessionEndText({ cause: "lost", seconds: 3840 })).toBe("Connection lost after 1h 4m");
    expect(viaText("direct")).toBe("outside the VPN");
    expect(viaText(null)).toBeNull();
  });
});

describe("service checks", () => {
  const checks = (latest: InsightServiceResult[], lastRunAt: string | null = "2026-11-18T10:00:00.000Z"): InsightServiceChecks => ({
    lastRunAt,
    runs: latest.length ? 1 : 0,
    latest,
    byServer: [],
  });

  it("names the route of the newest run", () => {
    expect(lastRunRoute(checks([result()]))).toBe("through exit-1, Xray VLESS+REALITY");
    expect(lastRunRoute(checks([result({ via: "direct", server: null, protocol: null })]))).toBe("outside the VPN");
    expect(lastRunRoute(checks([result({ server: null, protocol: null })]))).toBe("through the VPN, server not named");
    // A result from an older run says nothing about the newest one.
    expect(lastRunRoute(checks([result({ at: "2026-11-17T10:00:00.000Z" })]))).toBeNull();
    expect(lastRunRoute(checks([], null))).toBeNull();
  });

  /** `latest` mixes runs; the headline count is the newest run's own. */
  it("counts only the newest run's results for its headline", () => {
    const older = "2026-11-08T10:00:00.000Z";
    const latest = [
      result({ key: "google" }),
      result({ key: "x", ok: false, at: older, via: "direct", server: null }),
      result({ key: "youtube", ok: false, at: older, via: "direct", server: null }),
    ];
    expect(lastRunCounts(checks(latest))).toEqual({ reachable: 1, total: 1 });
    expect(lastRunCounts(checks([result({ at: older })]))).toBeNull();
    expect(lastRunCounts(checks([], null))).toBeNull();
  });

  it("calls a group outside the VPN only when the runs said direct", () => {
    expect(routeGroupLabel({ server: "exit-1", via: "tunnel" })).toBe("exit-1");
    expect(routeGroupLabel({ server: null, via: "direct" })).toBe("Outside the VPN");
    expect(routeGroupLabel({ server: null, via: "tunnel" })).toBe("unknown server");
    expect(routeGroupLabel({ server: null, via: null })).toBe("Route not stated");
  });

  it("says the kind of address, never an address", () => {
    expect(addressKindText("private")).toBe("a private address");
    expect(addressKindText(null)).toBeNull();
    expect(resolvedText("203.0.113.7", "reserved")).toBe("203.0.113.7 (a reserved address)");
    expect(resolvedText("198.51.100.4", null)).toBe("198.51.100.4");
    expect(resolvedText(null, "public")).toBe("a public address");
    expect(resolvedText(null, null)).toBeNull();
  });
});

describe("diagnostics links", () => {
  it("builds and reads the reference link", () => {
    expect(diagnosticsHref(ID, "4f2a9c1e")).toBe(`/customers/${ID}?view=diagnostics&ref=4f2a9c1e`);
    expect(diagnosticsHref(ID)).toBe(`/customers/${ID}?view=diagnostics`);
    // From page 2 of the list, the link opens page 2, where the bundle is.
    expect(diagnosticsHref(ID, "4f2a9c1e", { take: 20, skip: 20 })).toBe(`/customers/${ID}?view=diagnostics&ref=4f2a9c1e&take=20&skip=20`);
    expect(diagnosticsHref(ID, "4f2a9c1e", { take: 20, skip: 0 })).toBe(`/customers/${ID}?view=diagnostics&ref=4f2a9c1e&take=20`);
    expect(referenceFromLink(`/customers/${ID}?view=diagnostics&ref=4f2a9c1e`)).toBe("4f2a9c1e");
    expect(referenceFromLink("/customers/x?view=diagnostics")).toBeNull();
    expect(referenceFromLink(null)).toBeNull();
    expect(referenceFromLink("/x?ref=<script>")).toBeNull();
  });

  it("accepts only a hex reference from the query", () => {
    expect(diagnosticsApiPath(ID, { take: 20, skip: 0 })).toBe(`/customers/${ID}/diagnostics?take=20`);
    expect(diagnosticsApiPath(ID, { take: 20, skip: 40 })).toBe(`/customers/${ID}/diagnostics?take=20&skip=40`);
    // A reference asks for that one bundle, whatever page it is on.
    expect(diagnosticsApiPath(ID, { take: 20, skip: 40 }, "4F2A9C1E")).toBe(`/customers/${ID}/diagnostics?ref=4f2a9c1e`);
    expect(diagnosticsApiPath(ID, { take: 20, skip: 0 }, "4f2a9c1e-0000-4000-8000-000000000000")).toBe(
      `/customers/${ID}/diagnostics?ref=4f2a9c1e`,
    );
    expect(diagnosticsApiPath(ID, { take: 20, skip: 0 }, "4f2a")).toBe(`/customers/${ID}/diagnostics?take=20`);
    expect(lookupReference("4f2a")).toBeNull();
    expect(parseReference("4F2A9C1E")).toBe("4f2a9c1e");
    expect(parseReference(" 4f2a9c1e ")).toBe("4f2a9c1e");
    expect(parseReference("nope!")).toBeUndefined();
    expect(parseReference(undefined)).toBeUndefined();
  });
});
