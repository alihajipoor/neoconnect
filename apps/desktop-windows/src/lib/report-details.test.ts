import { beforeEach, describe, expect, it, vi } from "vitest";

/** The details a report carries (report-details.ts): every part optional,
 * held to the server's validators, capped in size, and absent when the
 * native command is. */

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

type Details = typeof import("./report-details");
let rd: Details;

const FACTS = {
  model: "Example Laptop 13",
  os: "Windows",
  osVersion: "11 26100.2314",
  lowPower: false,
  memFreeMb: 4096,
  net: { type: "wifi", ipv4: true, ipv6: false, dns: ["192.0.2.53", "2001:db8::53"] },
};

beforeEach(async () => {
  invoke.mockReset();
  vi.resetModules();
  rd = await import("./report-details");
  rd.resetReportDetailsForTests();
});

describe("the device and network facts", () => {
  it("are left out entirely when the command is missing -- the language too", async () => {
    invoke.mockRejectedValue("command device_facts not found");
    rd.setLanguageSource(() => "fa");
    expect(await rd.readFacts()).toEqual({});
    expect(await rd.collectDetails("SIGN_IN")).toBeUndefined();
  });

  it("are left out when the command answers with something that is not facts", async () => {
    invoke.mockResolvedValue("ios");
    expect(await rd.collectDetails("CONNECT")).toBeUndefined();
  });

  it("carry what the command said, with the interface language", async () => {
    invoke.mockResolvedValue(FACTS);
    rd.setLanguageSource(() => "fa");
    const details = await rd.collectDetails("SIGN_IN");
    expect(details).toEqual({
      device: { model: "Example Laptop 13", os: "Windows", osVersion: "11 26100.2314", language: "fa", lowPower: false, memFreeMb: 4096 },
      net: { type: "wifi", ipv4: true, ipv6: false, dns: ["192.0.2.53", "2001:db8::53"] },
    });
  });

  it("keep the model and system for the run, and read free memory, savers and the network at most every 30 s", async () => {
    let clock = 1_000_000;
    invoke.mockResolvedValue(FACTS);
    await rd.readFacts(() => clock);
    clock += 10_000;
    invoke.mockResolvedValue({ ...FACTS, memFreeMb: 1, lowPower: true });
    const soon = await rd.readFacts(() => clock);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(soon.device).toMatchObject({ memFreeMb: 4096, lowPower: false });
    clock += rd.NET_FRESH_MS;
    invoke.mockResolvedValue({
      ...FACTS,
      model: "changed",
      os: "changed",
      osVersion: "changed",
      memFreeMb: 1024,
      lowPower: true,
      dataSaver: true,
      net: { type: "cellular" },
    });
    const again = await rd.readFacts(() => clock);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(again.device).toEqual({
      model: "Example Laptop 13",
      os: "Windows",
      osVersion: "11 26100.2314",
      memFreeMb: 1024,
      lowPower: true,
      dataSaver: true,
    });
    expect(again.net).toEqual({ type: "cellular" });
  });

  it("do not send an old free-memory reading when a later read fails", async () => {
    let clock = 1_000_000;
    invoke.mockResolvedValue(FACTS);
    await rd.readFacts(() => clock);
    clock += rd.NET_FRESH_MS;
    invoke.mockRejectedValue(new Error("gone"));
    const after = await rd.readFacts(() => clock);
    expect(after.device).toEqual({ model: "Example Laptop 13", os: "Windows", osVersion: "11 26100.2314" });
    expect(after.net).toBeUndefined();
  });

  it("drop every field the server would refuse, keeping the rest", async () => {
    invoke.mockResolvedValue({
      model: "x".repeat(200),
      os: 7,
      memFreeMb: -5,
      computerName: "DESKTOP-EXAMPLE",
      net: {
        type: "satellite",
        dns: ["192.0.2.1", "resolver.example.com", "300.1.1.1", "fe80::1%eth0", "198.51.100.1", "198.51.100.2", "198.51.100.3"],
        privateDns: "host",
        privateDnsHost: "dns.example.net",
        adapterName: "Wi-Fi 2",
      },
    });
    const { device, net } = await rd.readFacts();
    expect(device).toEqual({ model: "x".repeat(64), memFreeMb: 0 });
    expect(net).toEqual({
      dns: ["192.0.2.1", "198.51.100.1", "198.51.100.2", "198.51.100.3"],
      privateDns: "host",
      privateDnsHost: "dns.example.net",
    });
  });
});

describe("every part", () => {
  it("is optional: an empty object is nothing at all", () => {
    expect(rd.sanitizeDetails({})).toBeUndefined();
    expect(rd.sanitizeDetails(null)).toBeUndefined();
    expect(rd.sanitizeDetails({ device: {}, net: {}, tunnel: {}, dataCheck: {}, reconnect: {} })).toBeUndefined();
  });

  it("is held to the server's shapes", () => {
    expect(
      rd.sanitizeDetails({
        errorKind: "serverUnreachable".repeat(5),
        dataCheck: { down: { status: "200", bytes: 131072, ms: 812.6 }, up: { status: "none", bytes: 0 } },
        egress: { state: "throughTunnel", ms: 1234.4 },
        reconnect: { attempt: 2, quickDeaths: 1, spentMs: -3, droppedSecondsAgo: 12 },
        sessionEnd: { cause: "lost", seconds: 9_999_999 },
        via: "sideways",
        targetsVersion: 1,
        visited: "example.com",
      }),
    ).toEqual({
      errorKind: "serverUnreachable".repeat(5).slice(0, 40),
      dataCheck: { down: { status: "200", bytes: 131072, ms: 813 } },
      egress: { state: "throughTunnel", ms: 1234 },
      reconnect: { attempt: 2, quickDeaths: 1, spentMs: 0, droppedSecondsAgo: 12 },
      sessionEnd: { cause: "lost", seconds: 7 * 86_400 },
      targetsVersion: 1,
    });
  });

  it("keeps a service result only with its key, host, ok and stage, and an address only as an IP", () => {
    expect(
      rd.sanitizeDetails({
        services: [
          { key: "google", host: "www.example.com", ok: true, stage: "ok", tlsMs: 30.2, status: 204, address: "192.0.2.10" },
          { key: "x", host: "x.example.com", ok: false, stage: "tls", address: "not-an-ip", error: "e".repeat(300) },
          { key: "bad", host: "y.example.com", ok: "yes", stage: "ok" },
        ],
      }),
    ).toEqual({
      services: [
        { key: "google", host: "www.example.com", ok: true, stage: "ok", tlsMs: 30, status: 204, address: "192.0.2.10" },
        { key: "x", host: "x.example.com", ok: false, stage: "tls", error: "e".repeat(120) },
      ],
    });
  });
});

describe("the size cap", () => {
  const big = () => ({
    device: { model: "m".repeat(64), os: "Windows", osVersion: "11" },
    net: { type: "wifi" as const, dns: ["192.0.2.1"] },
    reconnect: { attempt: 1 },
    egress: { state: "throughTunnel", ms: 10 },
    services: Array.from({ length: 16 }, (_, i) => ({
      key: `k${i}`,
      host: `h${i}.example.com`,
      ok: false,
      stage: "tls" as const,
      error: "e".repeat(120),
    })),
  });

  it("leaves a small object alone", () => {
    expect(rd.capDetails({ errorKind: "noNetwork" })).toEqual({ errorKind: "noNetwork" });
  });

  it("gives up the least useful parts first, never the whole object", () => {
    const capped = rd.capDetails(big(), 900)!;
    expect(new TextEncoder().encode(JSON.stringify(capped)).length).toBeLessThanOrEqual(900);
    expect(capped.services!.length).toBeGreaterThan(0);
    expect(capped.services!.length).toBeLessThan(16);
    expect(capped.services!.every((s) => s.error === undefined)).toBe(true);
    expect(capped.reconnect).toBeUndefined();
    expect(capped.device).toBeUndefined();
  });

  it("drops the error words before anything else", () => {
    const capped = rd.capDetails(big(), 3_000)!;
    expect(capped.services).toHaveLength(16);
    expect(capped.reconnect).toEqual({ attempt: 1 });
    expect(capped.device).toBeDefined();
  });

  it("keeps every report's details well under the server's 8 KB", async () => {
    invoke.mockResolvedValue(FACTS);
    const details = await rd.collectDetails("SERVICE_CHECK", big());
    expect(new TextEncoder().encode(JSON.stringify(details)).length).toBeLessThanOrEqual(rd.DETAILS_CAP_BYTES);
  });
});

describe("what a connect measured", () => {
  it("goes with one connect report, then is gone", async () => {
    invoke.mockRejectedValue("missing");
    rd.noteDataCheck({ down: { status: 200, bytes: 131072, ms: 400 }, up: { status: null, bytes: 1024, ms: 8000 } });
    rd.noteEgress("throughTunnel", 950);
    expect(await rd.collectDetails("CONNECT")).toEqual({
      dataCheck: { down: { status: "200", bytes: 131072, ms: 400 }, up: { status: "none", bytes: 1024, ms: 8000 } },
      egress: { state: "throughTunnel", ms: 950 },
    });
    expect(await rd.collectDetails("CONNECT")).toBeUndefined();
  });

  it("is not sent with a sign-in, nor when it is stale", async () => {
    invoke.mockRejectedValue("missing");
    rd.noteEgress("unreachable", 6000);
    expect(await rd.collectDetails("SIGN_IN")).toBeUndefined();
    rd.noteEgress("unreachable", 6000, () => 0);
    expect(rd.takeMeasurements(() => rd.MEASUREMENT_FRESH_MS + 1)).toEqual({});
  });

  it("adds the tunnel's settings to connects and sessions, and the caller's own on top", async () => {
    invoke.mockRejectedValue("missing");
    rd.landTunnel({ mode: "full", dns: ["1.1.1.1"] });
    rd.noteTunnel({ ipv6Blocked: true });
    expect(await rd.collectDetails("SESSION", { sessionEnd: { cause: "disconnected", seconds: 61 } })).toEqual({
      tunnel: { mode: "full", dns: ["1.1.1.1"], ipv6Blocked: true },
      sessionEnd: { cause: "disconnected", seconds: 61 },
    });
    expect(await rd.collectDetails("CONNECT", undefined, "SUCCESS")).toEqual({
      tunnel: { mode: "full", dns: ["1.1.1.1"], ipv6Blocked: true },
    });
    expect(await rd.collectDetails("SIGN_IN")).toBeUndefined();
  });

  it("names no tunnel on a failed connect, which landed nothing", async () => {
    invoke.mockRejectedValue("missing");
    rd.landTunnel({ mode: "full", splitTunnel: false });
    expect(await rd.collectDetails("CONNECT", { errorKind: "allFailed" }, "FAILURE")).toEqual({ errorKind: "allFailed" });
  });

  it("never carries an older session's settings into a new landing", async () => {
    invoke.mockRejectedValue("missing");
    rd.landTunnel({ mode: "full", dns: ["192.0.2.1"] });
    rd.noteTunnel({ splitTunnel: false, ipv6Blocked: true });
    // OpenVPN: no resolvers known to this layer, and Custom mode now.
    rd.landTunnel({ mode: "custom", dns: undefined });
    expect(rd.currentTunnel()).toEqual({ mode: "custom" });
    rd.clearTunnel();
    expect(rd.currentTunnel()).toBeUndefined();
    // A status poll answering after the teardown starts nothing.
    rd.noteTunnel({ ipv6Blocked: true });
    expect(rd.currentTunnel()).toBeUndefined();
  });

  it("reads the Windows service's flags only from a status that knows them", () => {
    const status = { connected: true, splitTunnelActive: true, ipv6Blocked: true, tunnelDnsUnprotected: true, sessionSecs: 3 };
    expect(rd.tunnelFlags(status, true)).toEqual({ splitTunnel: true, ipv6Blocked: true, dnsUnprotected: true });
    // WireGuard: no block or DNS rule of ours, and no Custom mode where it is not offered.
    expect(rd.tunnelFlags({ connected: true, splitTunnelActive: true, sessionSecs: 0 }, false)).toEqual({
      splitTunnel: false,
      ipv6Blocked: false,
      dnsUnprotected: false,
    });
    // The service's fallback while its thread is busy says `false` for what
    // it cannot read, and carries no session time: nothing is taken from it.
    expect(rd.tunnelFlags({ connected: true, ipv6Blocked: false }, true)).toEqual({});
    expect(rd.tunnelFlags({ connected: false, sessionSecs: 5 }, true)).toEqual({});
    expect(rd.tunnelFlags(null, true)).toEqual({});
  });

  it("puts the flags a landing knows on the connect report and the first service check", async () => {
    invoke.mockRejectedValue("missing");
    // As the ladder lands: the flags from its own status read, before any poll.
    const flags = rd.tunnelFlags({ connected: true, ipv6Blocked: true, sessionSecs: 4 }, true);
    rd.landTunnel({ mode: "full", dns: ["1.1.1.1"], ...flags });
    const tunnel = { mode: "full", dns: ["1.1.1.1"], splitTunnel: false, ipv6Blocked: true, dnsUnprotected: false };
    expect((await rd.collectDetails("CONNECT", undefined, "SUCCESS"))?.tunnel).toEqual(tunnel);
    expect((await rd.collectDetails("SERVICE_CHECK", { via: "tunnel" }, "SUCCESS"))?.tunnel).toEqual(tunnel);
    // A landing whose status read failed carries none, and the poll adds them later.
    rd.landTunnel({ mode: "full", ...rd.tunnelFlags(null, true) });
    expect(rd.currentTunnel()).toEqual({ mode: "full" });
    rd.noteTunnel(rd.tunnelFlags({ connected: true, sessionSecs: 15 }, true));
    expect(rd.currentTunnel()).toEqual({ mode: "full", splitTunnel: false, ipv6Blocked: false, dnsUnprotected: false });
  });

  it("takes the tunnel as it was when the report was made, not after a teardown", async () => {
    invoke.mockResolvedValue(FACTS);
    rd.landTunnel({ mode: "full" });
    const pending = rd.collectDetails("SESSION", { sessionEnd: { cause: "disconnected", seconds: 90 } });
    rd.clearTunnel();
    expect((await pending)?.tunnel).toEqual({ mode: "full" });
  });

  it("is put away when a new pass begins, however recent", async () => {
    invoke.mockRejectedValue("missing");
    rd.noteEgress("throughTunnel", 900);
    rd.clearMeasurements();
    expect(await rd.collectDetails("CONNECT", undefined, "FAILURE")).toBeUndefined();
  });
});

describe("the device's resolvers", () => {
  it("never include one that can carry the router's hardware address", () => {
    expect(rd.namesHardware("fe80::1a2b:3cff:fe4d:5e6f")).toBe(true);
    expect(rd.namesHardware("fe80::1")).toBe(true);
    expect(rd.namesHardware("febf::1")).toBe(true);
    expect(rd.namesHardware("2001:db8:0:1:1a2b:3cff:fe4d:5e6f")).toBe(true);
    expect(rd.namesHardware("2001:db8::53")).toBe(false);
    expect(rd.namesHardware("fec0::1")).toBe(false);
    expect(rd.namesHardware("::ffff:192.0.2.1")).toBe(false);
    expect(rd.namesHardware("192.0.2.1")).toBe(false);
    expect(
      rd.cleanNet({ dns: ["fe80::1a2b:3cff:fe4d:5e6f", "2001:db8:0:1:1a2b:3cff:fe4d:5e6f", "192.0.2.1", "2001:db8::53"] }),
    ).toEqual({ dns: ["192.0.2.1", "2001:db8::53"] });
  });
});

describe("the resolvers set inside the tunnel", () => {
  it("are the app's own, or left out where this layer does not know them", () => {
    expect(rd.tunnelResolvers("XRAY_VLESS_REALITY", {}, "windows")).toEqual(["1.1.1.1"]);
    expect(rd.tunnelResolvers("SHADOWSOCKS", {}, "mobile")).toEqual(["1.1.1.1"]);
    expect(rd.tunnelResolvers("WIREGUARD", { dns: "192.0.2.53, 2001:db8::1" }, "mobile")).toEqual(["192.0.2.53", "2001:db8::1"]);
    expect(rd.tunnelResolvers("WIREGUARD", {}, "windows")).toBeUndefined();
    expect(rd.tunnelResolvers("IKEV2", {}, "windows")).toEqual(["1.1.1.1"]);
    expect(rd.tunnelResolvers("IKEV2", {}, "mobile")).toBeUndefined();
    expect(rd.tunnelResolvers("OPENVPN", {}, "windows")).toBeUndefined();
    expect(rd.tunnelResolvers("XRAY_VMESS", {}, "linux")).toBeUndefined();
  });
});

describe("an IP literal", () => {
  it("is what the server's IsIP accepts, and nothing looser", () => {
    for (const ip of ["192.0.2.1", "0.0.0.0", "2001:db8::1", "::1", "::", "2001:db8:0:0:0:0:0:1", "::ffff:192.0.2.1"]) {
      expect(rd.isIpLiteral(ip)).toBe(true);
    }
    for (const ip of ["192.0.2", "01.2.3.4", "256.0.0.1", "fe80::1%eth0", "2001:db8:::1", "1:2:3:4:5:6:7:8:9", "example.com", ""]) {
      expect(rd.isIpLiteral(ip)).toBe(false);
    }
  });
});
