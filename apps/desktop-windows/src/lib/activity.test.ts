import { describe, expect, it } from "vitest";
import { activitySummary, networkActivity } from "./activity";
import { recordAttempt, type ConnectHistory } from "./connect-history";
import { LAMP_FRESH_MS } from "./map-lights";
import type { RouteOption } from "./types";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function route(id: string, protocol: RouteOption["protocol"]): RouteOption {
  return {
    id,
    name: id,
    protocol,
    isRelay: false,
    location: { region: "de-germany", nodeName: "n" },
    endpoint: { host: "203.0.113.10", port: 443 },
    nodeStatus: "ONLINE",
  } as RouteOption;
}

const ROUTES = [route("de", "XRAY_VLESS_REALITY"), route("fi", "WIREGUARD")];

function history(entries: [string | null, string, RouteOption["protocol"], boolean, number][]): ConnectHistory {
  let h: ConnectHistory = {};
  for (const [net, id, protocol, ok, minutesAgo] of entries) h = recordAttempt(h, net, id, protocol, ok, NOW - minutesAgo * MIN);
  return h;
}

describe("what the Activity page says works on this network", () => {
  it("says nothing when the network is not known, rather than borrow the shared bucket", () => {
    const h = history([[null, "de", "XRAY_VLESS_REALITY", true, 5]]);
    expect(networkActivity(h, null, ROUTES, NOW)).toEqual([]);
  });

  it("shows only this network's attempts", () => {
    const h = history([
      ["home", "de", "XRAY_VLESS_REALITY", true, 5],
      ["work", "fi", "WIREGUARD", true, 3],
    ]);
    const rows = networkActivity(h, "home", ROUTES, NOW);
    expect(rows.map((r) => r.routeId)).toEqual(["de"]);
    expect(rows[0].route?.protocol).toBe("XRAY_VLESS_REALITY");
  });

  it("leaves out what is older than the lights' freshness window", () => {
    const old = LAMP_FRESH_MS / MIN + 1;
    const h = history([["home", "de", "XRAY_VLESS_REALITY", true, old]]);
    expect(networkActivity(h, "home", ROUTES, NOW)).toEqual([]);
  });

  it("goes by the newest try: a failure after a success is shown as a failure", () => {
    const h = history([
      ["home", "de", "XRAY_VLESS_REALITY", true, 60],
      ["home", "de", "XRAY_VLESS_REALITY", false, 10],
    ]);
    const [row] = networkActivity(h, "home", ROUTES, NOW);
    expect(row.latest.ok).toBe(false);
    expect(row.worked).toBe(1);
    expect(row.tries).toBe(2);
    expect(activitySummary([row])).toEqual({ worked: 0, tried: 1 });
  });

  it("lists the newest first, and keeps a route no longer in the list without inventing one", () => {
    const h = history([
      ["home", "de", "XRAY_VLESS_REALITY", true, 30],
      ["home", "gone", "SHADOWSOCKS", false, 2],
    ]);
    const rows = networkActivity(h, "home", ROUTES, NOW);
    expect(rows.map((r) => r.routeId)).toEqual(["gone", "de"]);
    expect(rows[0].route).toBeNull();
    expect(rows[0].protocol).toBe("SHADOWSOCKS");
  });

  it("counts a clock that moved forward as now, not as fresher than now", () => {
    let h: ConnectHistory = {};
    h = recordAttempt(h, "home", "de", "XRAY_VLESS_REALITY", true, NOW + 10 * MIN);
    const rows = networkActivity(h, "home", ROUTES, NOW);
    expect(rows).toHaveLength(1);
  });
});
