import { describe, expect, it } from "vitest";
import { recordAttempt, type ConnectHistory } from "./connect-history";
import { LAMP_FRESH_MS, LAMP_MAX_ANIM, mapCountries, mapLights, placeEvidence, verifiedTone, type MapLightsInput } from "./map-lights";
import type { ShownTone } from "./hero-model";
import type { RouteOption } from "./types";

/** The world map's lights (design-system.md 5.3): a light twinkles only on
 * evidence that traffic was carried on this network lately, the connected
 * light only under the verified look, and nothing else -- no latency, no
 * guess, no old or other network's history -- ever moves one. */

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const NET = "gw:aa:bb";
const HOUR = 3_600_000;

function route(id: string, region: string, protocol: RouteOption["protocol"], extra: Partial<RouteOption> = {}): RouteOption {
  return {
    id,
    name: id,
    protocol,
    isRelay: false,
    location: { region, nodeName: `node-${id}` },
    endpoint: { host: "203.0.113.10", port: 443 },
    nodeStatus: "ONLINE",
    ...extra,
  };
}
const relay = (id: string, exit: string, protocol: RouteOption["protocol"] = "XRAY_VLESS_TLS", extra: Partial<RouteOption> = {}) =>
  route(id, "ir-iran", protocol, { isRelay: true, exitLocation: { region: exit }, ...extra });

const DE_REALITY = route("de-r", "de-germany", "XRAY_VLESS_REALITY");
const DE_WG = route("de-wg", "de-germany", "WIREGUARD");
const FI = route("fi-r", "fi-finland", "XRAY_VLESS_REALITY");
const TR = route("tr-ss", "tr-turkey", "SHADOWSOCKS");
const IR_DE = relay("ir-de", "de-germany");
const ROUTES = [DE_REALITY, DE_WG, FI, TR, IR_DE];

const works = { code: "worksOnYourIsp" as const, customers: 12, outOf: 14, windowHours: 24 };
const failing = { code: "failingOnYourIsp" as const, customers: 9, outOf: 10, windowHours: 24 };

function history(...entries: [routeId: string, protocol: RouteOption["protocol"], ok: boolean, agoMs: number, network?: string | null][]): ConnectHistory {
  let h: ConnectHistory = {};
  for (const [routeId, protocol, ok, ago, network] of entries) h = recordAttempt(h, network === undefined ? NET : network, routeId, protocol, ok, NOW - ago);
  return h;
}

function scene(over: Partial<MapLightsInput> = {}) {
  return mapLights({ routes: ROUTES, history: {}, network: NET, now: NOW, verified: null, tone: "idle", shown: null, ...over });
}
const light = (s: ReturnType<typeof scene>, cc: string) => s.lights.find((l) => l.cc === cc);

describe("placeEvidence", () => {
  const ctx = (h: ConnectHistory, network: string | null = NET) => ({ history: h, network, now: NOW });

  it("is a steady dot with nothing known -- a new install, never a blink", () => {
    expect(placeEvidence([DE_REALITY, DE_WG], ctx({}))).toEqual({ look: "idle", why: "none" });
  });

  it("twinkles on this device's own verified connect here, within a day", () => {
    const ev = placeEvidence([DE_REALITY, DE_WG], ctx(history(["de-r", "XRAY_VLESS_REALITY", true, 2 * HOUR])));
    expect(ev).toEqual({ look: "live", why: "own", protocol: "XRAY_VLESS_REALITY", at: NOW - 2 * HOUR });
  });

  it("forgets evidence older than the freshness window", () => {
    const old = history(["de-r", "XRAY_VLESS_REALITY", true, LAMP_FRESH_MS + 1]);
    expect(placeEvidence([DE_REALITY], ctx(old)).look).toBe("idle");
    const failedOld = history(["de-r", "XRAY_VLESS_REALITY", false, LAMP_FRESH_MS + 1]);
    expect(placeEvidence([DE_REALITY], ctx(failedOld)).look).toBe("idle");
  });

  it("reads only the network the device is on now", () => {
    const elsewhere = history(["de-r", "XRAY_VLESS_REALITY", true, HOUR, "gw:other"]);
    expect(placeEvidence([DE_REALITY], ctx(elsewhere)).look).toBe("idle");
  });

  it("ignores this device's history altogether when the network is unknown", () => {
    // Recorded under the shared "unknown" bucket, which may describe any network.
    const unknown = history(["de-r", "XRAY_VLESS_REALITY", true, HOUR, null]);
    expect(placeEvidence([DE_REALITY], ctx(unknown, null))).toEqual({ look: "idle", why: "none" });
  });

  it("counts an unverified landing as no proof: a failure, never a blink", () => {
    // Dashboard records `verdict === "connected"`; an engine that started and
    // proved nothing arrives here as ok: false.
    const ev = placeEvidence([DE_REALITY], ctx(history(["de-r", "XRAY_VLESS_REALITY", false, HOUR])));
    expect(ev).toEqual({ look: "down", why: "failed", protocol: "XRAY_VLESS_REALITY", at: NOW - HOUR });
  });

  it("takes the newest attempt: a success then a failure is a failure", () => {
    const h = history(["de-r", "XRAY_VLESS_REALITY", true, 3 * HOUR], ["de-r", "XRAY_VLESS_REALITY", false, HOUR]);
    expect(placeEvidence([DE_REALITY], ctx(h)).look).toBe("down");
    const back = history(["de-r", "XRAY_VLESS_REALITY", false, 3 * HOUR], ["de-r", "XRAY_VLESS_REALITY", true, HOUR]);
    expect(placeEvidence([DE_REALITY], ctx(back)).look).toBe("live");
  });

  it("lets any worked way in win over a failed one at the same place", () => {
    const h = history(["de-r", "XRAY_VLESS_REALITY", false, HOUR], ["de-wg", "WIREGUARD", true, 5 * HOUR]);
    expect(placeEvidence([DE_REALITY, DE_WG], ctx(h))).toMatchObject({ look: "live", why: "own", protocol: "WIREGUARD" });
  });

  it("twinkles on other people's reports from this network, and is hollow on theirs failing", () => {
    expect(placeEvidence([{ ...FI, ispTag: works }], ctx({}))).toEqual({ look: "live", why: "isp", protocol: "XRAY_VLESS_REALITY" });
    expect(placeEvidence([{ ...FI, ispTag: failing }], ctx({}))).toEqual({ look: "down", why: "ispFail", protocol: "XRAY_VLESS_REALITY" });
  });

  it("puts this device's own word over other people's for the same protocol", () => {
    const mine = history(["fi-r", "XRAY_VLESS_REALITY", false, HOUR]);
    expect(placeEvidence([{ ...FI, ispTag: works }], ctx(mine))).toMatchObject({ look: "down", why: "failed" });
    // ...but other people's word still counts for a protocol it has not tried.
    const fiWg = route("fi-wg", "fi-finland", "WIREGUARD", { ispTag: works });
    expect(placeEvidence([FI, fiWg], ctx(mine))).toEqual({ look: "live", why: "isp", protocol: "WIREGUARD" });
  });

  it("is hollow when the control plane reports every route there down, whatever worked before", () => {
    const h = history(["de-r", "XRAY_VLESS_REALITY", true, HOUR]);
    const down = [{ ...DE_REALITY, nodeStatus: "OFFLINE" as const }, { ...DE_WG, nodeStatus: "PENDING" as const, ispTag: works }];
    expect(placeEvidence(down, ctx(h))).toEqual({ look: "down", why: "offline" });
  });

  it("takes no evidence from a route the control plane reports down", () => {
    const h = history(["de-r", "XRAY_VLESS_REALITY", true, HOUR]);
    expect(placeEvidence([{ ...DE_REALITY, nodeStatus: "DISABLED" }, DE_WG], ctx(h))).toEqual({ look: "idle", why: "none" });
  });
});

describe("mapLights", () => {
  it("shows a new install as steady dots only: nothing moves, nothing is connected", () => {
    const s = scene();
    expect(s.lights.map((l) => l.cc).sort()).toEqual(["de", "fi", "ir", "tr"]);
    for (const l of s.lights) {
      expect(l).toMatchObject({ look: "idle", why: "none", exit: false, anim: false, listed: true });
    }
    expect(s.arc).toBeNull();
  });

  it("makes a light move only where there is evidence", () => {
    const s = scene({ history: history(["fi-r", "XRAY_VLESS_REALITY", true, HOUR]), routes: [DE_REALITY, FI, { ...TR, ispTag: failing }] });
    expect(light(s, "fi")).toMatchObject({ look: "live", anim: true });
    expect(light(s, "de")).toMatchObject({ look: "idle", anim: false });
    expect(light(s, "tr")).toMatchObject({ look: "down", anim: false });
  });

  it("lights Iran for a relay, never the exit country's own light", () => {
    const s = scene({ history: history(["ir-de", "XRAY_VLESS_TLS", true, HOUR]) });
    expect(light(s, "ir")).toMatchObject({ look: "live", why: "own" });
    expect(light(s, "de")).toMatchObject({ look: "idle" });
  });

  it("gives a country its best place, this device's own evidence first", () => {
    const routes = [relay("ir-de", "de-germany", "XRAY_VLESS_TLS", { ispTag: works }), relay("ir-fi", "fi-finland", "XRAY_VLESS_REALITY")];
    const s = scene({ routes, history: history(["ir-fi", "XRAY_VLESS_REALITY", true, HOUR]) });
    expect(s.lights).toHaveLength(1);
    expect(light(s, "ir")).toMatchObject({ look: "live", why: "own", protocol: "XRAY_VLESS_REALITY" });
  });

  it("does not draw a country the map has no anchor for; the list stays the truth", () => {
    const s = scene({ routes: [...ROUTES, route("jp", "jp-japan", "WIREGUARD", { ispTag: works }), route("odd", "frankfurt", "WIREGUARD")] });
    expect(light(s, "jp")).toBeUndefined();
    expect(s.lights).toHaveLength(4);
  });

  describe("the connected light", () => {
    it("is drawn where a verified tunnel leaves, under the verified look", () => {
      for (const tone of ["ok", "caution"] as ShownTone[]) {
        const s = scene({ verified: DE_REALITY, tone, shown: DE_REALITY });
        expect(light(s, "de"), tone).toMatchObject({ exit: true, anim: true });
        expect(s.lights.filter((l) => l.exit)).toHaveLength(1);
      }
    });

    it("is never drawn for a tunnel that is up and not verified", () => {
      // "Connected, not confirmed" wears hl; nothing has been verified, so
      // the screen has no verified route to pass either.
      for (const verified of [null, DE_REALITY]) {
        const s = scene({ verified, tone: "hl", shown: DE_REALITY });
        expect(s.lights.some((l) => l.exit)).toBe(false);
      }
    });

    it("is not drawn while connecting, checking, after a drop, or past the hold", () => {
      for (const tone of ["idle", "warn", "danger", "muted"] as ShownTone[]) {
        const s = scene({ verified: DE_REALITY, tone, shown: DE_REALITY });
        expect(s.lights.some((l) => l.exit), tone).toBe(false);
      }
      expect(verifiedTone("hl")).toBe(false);
    });

    it("does not make a place's evidence: connected is not 'worked here'", () => {
      const s = scene({ verified: FI, tone: "ok", shown: FI });
      expect(light(s, "fi")).toMatchObject({ exit: true, look: "idle", why: "none" });
    });

    it("stands on a relay's exit country, with a solid arc from Iran", () => {
      const s = scene({ verified: IR_DE, tone: "ok", shown: IR_DE });
      expect(light(s, "de")).toMatchObject({ exit: true });
      expect(light(s, "ir")).toMatchObject({ exit: false });
      expect(s.arc).toEqual({ from: "ir", to: "de", solid: true });
    });

    it("is drawn for a relay exit with no direct place of its own, and only then", () => {
      const toFr = relay("ir-fr", "fr-france");
      const s = scene({ routes: [DE_REALITY, toFr], verified: toFr, tone: "ok", shown: toFr });
      expect(light(s, "fr")).toMatchObject({ exit: true, listed: false });
      const idle = scene({ routes: [DE_REALITY, toFr], verified: toFr, tone: "hl", shown: toFr });
      expect(light(idle, "fr")).toBeUndefined();
    });
  });

  describe("the relay arc", () => {
    it("is dashed while a relay is only picked, or up and not yet verified", () => {
      expect(scene({ shown: IR_DE }).arc).toEqual({ from: "ir", to: "de", solid: false });
      expect(scene({ shown: IR_DE, tone: "hl", verified: null }).arc).toEqual({ from: "ir", to: "de", solid: false });
    });

    it("is absent for a direct route, or a relay from a backend that does not name its exit", () => {
      expect(scene({ shown: DE_REALITY }).arc).toBeNull();
      expect(scene({ shown: relay("ir-x", "") }).arc).toBeNull();
      expect(scene({ shown: { ...IR_DE, exitLocation: null } }).arc).toBeNull();
    });
  });

  it("moves at most the budgeted number of lights, the connected one first", () => {
    const anchors = ["gb", "fr", "de", "fi", "tr", "ir", "sg", "nl", "ae", "us"];
    const extra = ["aa", "bb"];
    const routes = [...anchors, ...extra].map((cc) => route(cc, `${cc}-x`, "WIREGUARD", { ispTag: works }));
    const s = mapLights({
      routes,
      history: {},
      network: NET,
      now: NOW,
      verified: routes[0],
      tone: "ok",
      shown: routes[0],
      drawable: () => true,
    });
    expect(s.lights.filter((l) => l.look === "live")).toHaveLength(12);
    expect(s.lights.filter((l) => l.anim)).toHaveLength(LAMP_MAX_ANIM);
    expect(light(s, "gb")).toMatchObject({ exit: true, anim: true });
  });
});

describe("mapCountries", () => {
  it("names every country the list can light or leave from, once, in list order", () => {
    const routes = [DE_REALITY, relay("ir-fr", "fr-france"), FI, DE_WG, route("jp", "jp-japan", "WIREGUARD")];
    expect(mapCountries(routes)).toEqual(["de", "ir", "fr", "fi"]);
  });
});
