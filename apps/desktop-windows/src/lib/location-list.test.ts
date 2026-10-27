import { describe, expect, it } from "vitest";
import { recordAttempt, type ConnectHistory } from "./connect-history";
import { buildList, bestLatency, listEmpty, listKey, routeWorked, rowEvidence, searchText, udpOnly, type ListFilter } from "./location-list";
import { mapLights, ownWorkedAt, placesEvidence, type EvidenceContext } from "./map-lights";
import { withoutTags } from "./map-network";
import type { RouteOption } from "./types";

/** The server list (design-system.md 4.8): one row per country, every
 * protocol under it, a search that never hides a protocol it was not asked
 * to, and a "Worked here" filter that agrees with the map's lights. */

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
  route(id, "ir-iran", protocol, { isRelay: true, exitLocation: { region: exit }, transport: "WS", ...extra });

const works = { code: "worksOnYourIsp" as const, customers: 12, outOf: 14, windowHours: 24 };
const failing = { code: "failingOnYourIsp" as const, customers: 9, outOf: 10, windowHours: 24 };

const DE_WS = route("de-ws", "de-germany", "XRAY_VLESS_TLS", { transport: "WS", ispTag: works });
const DE_WG = route("de-wg", "de-germany", "WIREGUARD");
const FI = route("fi-r", "fi-finland", "XRAY_VLESS_REALITY");
const FR = route("fr-ss", "fr-france", "SHADOWSOCKS");
const TR = route("tr-ike", "tr-turkey", "IKEV2", { ispTag: failing });
const GB = route("gb-r", "gb-united-kingdom", "XRAY_VLESS_REALITY", { nodeStatus: "OFFLINE" });
const IR_DE = relay("ir-de", "de-germany");
const IR_FI = relay("ir-fi", "fi-finland", "XRAY_VLESS_REALITY", { transport: undefined });
// The relay's routes interleave their exits in the server's order.
const IR_DE2 = relay("ir-de-2", "de-germany", "XRAY_TROJAN", { transport: undefined });
const ROUTES = [DE_WS, IR_DE, DE_WG, FI, IR_FI, FR, TR, GB, IR_DE2];

const AUTO = ["Automatic", "خودکار"];
const none = () => false;

function history(...entries: [routeId: string, protocol: RouteOption["protocol"], ok: boolean, agoMs: number][]): ConnectHistory {
  let h: ConnectHistory = {};
  for (const [routeId, protocol, ok, ago] of entries) h = recordAttempt(h, NET, routeId, protocol, ok, NOW - ago);
  return h;
}

const ids = (routes: readonly RouteOption[]) => routes.map((r) => r.id);

describe("one row per country", () => {
  const list = buildList(ROUTES, { query: "", filter: "all", worked: none, automaticTerms: AUTO });

  it("puts Automatic first, then the countries, then the routes through Iran, in the server's order", () => {
    expect(list.automatic).toBe(true);
    expect(list.countries.map((p) => p.key)).toEqual(["c:de", "c:fi", "c:fr", "c:tr", "c:gb"]);
    expect(list.relays.map((p) => p.key)).toEqual(["r:ir>de", "r:ir>fi"]);
  });

  it("keeps every protocol under its country, offline ones included: nothing is dropped", () => {
    const shown = [...list.countries, ...list.relays].flatMap((p) => ids(p.shown)).sort();
    expect(shown).toEqual(ids(ROUTES).sort());
    expect(ids(list.countries[0].shown)).toEqual(["de-ws", "de-wg"]);
    expect(ids(list.relays[0].shown)).toEqual(["ir-de", "ir-de-2"]);
    expect(list.countries.every((p) => !p.open)).toBe(true);
  });

  it("takes one country with two region slugs as one row", () => {
    const two = [route("a", "de-germany", "WIREGUARD"), route("b", "de-frankfurt", "XRAY_VLESS_REALITY")];
    expect(buildList(two, { query: "", filter: "all", worked: none, automaticTerms: AUTO }).countries).toHaveLength(1);
    expect(listKey(two[0])).toBe(listKey(two[1]));
    // Iran to Germany and Germany itself are different places.
    expect(listKey(IR_DE)).not.toBe(listKey(DE_WS));
  });
});

describe("search", () => {
  const find = (query: string, filter: ListFilter = "all") => buildList(ROUTES, { query, filter, worked: none, automaticTerms: AUTO });

  it("finds a country by its English or Persian name, whatever the screen is in", () => {
    for (const q of ["germ", "GERMANY", "آلمان"]) {
      const list = find(q);
      expect(list.countries.map((p) => p.key), q).toEqual(["c:de"]);
      // A relay leaving from Germany is Germany too.
      expect(list.relays.map((p) => p.key), q).toEqual(["r:ir>de"]);
      expect(ids(list.countries[0].shown)).toEqual(["de-ws", "de-wg"]);
      expect(list.countries[0].open).toBe(false);
    }
  });

  it("finds the backup routes by their name or relay, in either language", () => {
    for (const q of ["backup", "backup route", "مسیر پشتیبان", "relay"]) {
      expect(find(q).relays.map((p) => p.key), q).toEqual(["r:ir>de", "r:ir>fi"]);
      expect(find(q).countries, q).toEqual([]);
    }
  });

  it("does not find the backup routes by their entry's country, which no screen names", () => {
    for (const q of ["iran", "ایران"]) expect(find(q).relays, q).toEqual([]);
  });

  it("opens a country that matches only by a protocol, showing only that protocol", () => {
    const list = find("fast");
    expect(list.countries.map((p) => p.key)).toEqual(["c:de"]);
    expect(ids(list.countries[0].shown)).toEqual(["de-wg"]);
    expect(list.countries[0].open).toBe(true);
    // The operator's name for it finds it too.
    expect(ids(find("wireguard").countries[0].shown)).toEqual(["de-wg"]);
    expect(ids(find("stealth web").countries[0].shown)).toEqual(["de-ws"]);
  });

  it("offers Automatic to its own name only, and an empty list as empty", () => {
    expect(find("auto").automatic).toBe(true);
    expect(find("خودکار").automatic).toBe(true);
    expect(find("germany").automatic).toBe(false);
    const nothing = find("atlantis");
    expect(listEmpty(nothing)).toBe(true);
  });

  it("reads Arabic letter forms and joiners as Persian", () => {
    expect(searchText("ايران")).toBe(searchText("ایران"));
    expect(searchText("آلمان‌")).toBe("آلمان");
  });
});

describe("filters", () => {
  it("keeps only the backup routes on Backup routes, and no Automatic", () => {
    const list = buildList(ROUTES, { query: "", filter: "relay", worked: none, automaticTerms: AUTO });
    expect(list.automatic).toBe(false);
    expect(list.countries).toEqual([]);
    expect(list.relays.map((p) => p.key)).toEqual(["r:ir>de", "r:ir>fi"]);
  });

  it("shows an empty Worked list as empty rather than quietly showing everything", () => {
    const list = buildList(ROUTES, { query: "", filter: "worked", worked: none, automaticTerms: AUTO });
    expect(listEmpty(list)).toBe(true);
  });
});

/** The list and the map read the same evidence: a country row says what its
 * light says, and "Worked here" keeps exactly the places whose light
 * twinkles -- for every sample, including a roam (tags not yet re-read) and
 * an unknown network. */
describe("the list agrees with the map's lights", () => {
  const samples: { name: string; routes: RouteOption[]; history: ConnectHistory; network: string | null; tags: boolean }[] = [
    { name: "new install", routes: ROUTES.map((r) => ({ ...r, ispTag: null })), history: {}, network: NET, tags: true },
    {
      name: "mixed",
      routes: ROUTES,
      history: history(["fi-r", "XRAY_VLESS_REALITY", true, 2 * HOUR], ["fr-ss", "SHADOWSOCKS", false, HOUR]),
      network: NET,
      tags: true,
    },
    {
      name: "censored",
      routes: ROUTES.map((r) => (r.id === "ir-fi" ? { ...r, ispTag: works } : { ...r, ispTag: null })),
      history: history(
        ["de-ws", "XRAY_VLESS_TLS", false, HOUR],
        ["ir-de", "XRAY_VLESS_TLS", true, 3 * HOUR],
        ["gb-r", "XRAY_VLESS_REALITY", true, HOUR],
      ),
      network: NET,
      tags: true,
    },
    { name: "roamed", routes: ROUTES, history: history(["fi-r", "XRAY_VLESS_REALITY", true, HOUR]), network: NET, tags: false },
    { name: "network unknown", routes: ROUTES, history: history(["fi-r", "XRAY_VLESS_REALITY", true, HOUR]), network: null, tags: true },
    { name: "too old", routes: ROUTES, history: history(["fi-r", "XRAY_VLESS_REALITY", true, 30 * HOUR]), network: NET, tags: true },
  ];

  for (const sample of samples) {
    it(sample.name, () => {
      const ctx: EvidenceContext = { history: sample.history, network: sample.network, now: NOW };
      // What the Dashboard gives the map: the tags only while they are this network's.
      const mapRoutes = sample.tags ? sample.routes : withoutTags(sample.routes);
      const evidence = placesEvidence(mapRoutes, ctx);
      const inputs = { ownAt: (r: RouteOption) => ownWorkedAt(r, ctx), tags: sample.tags };
      const worked = (r: RouteOption) => routeWorked(r, inputs);
      const all = buildList(sample.routes, { query: "", filter: "all", worked, automaticTerms: AUTO });
      const kept = buildList(sample.routes, { query: "", filter: "worked", worked, automaticTerms: AUTO });
      const keptKeys = new Set([...kept.countries, ...kept.relays].map((p) => p.key));
      for (const place of [...all.countries, ...all.relays]) {
        const said = rowEvidence(place, evidence);
        // The row's words and the filter agree with each other ...
        expect(keptKeys.has(place.key), place.key).toBe(said.look === "live");
        expect(place.routes.some(worked), place.key).toBe(said.look === "live");
      }
      // ... and with the lights: a country row that worked is a country
      // whose light twinkles (relays light Iran).
      const scene = mapLights({ routes: mapRoutes, ...ctx, verified: null, tone: "idle", shown: null });
      for (const place of all.countries) {
        const cc = place.key.slice(2);
        const lamp = scene.lights.find((l) => l.cc === cc);
        if (lamp) expect(lamp.look, place.key).toBe(rowEvidence(place, evidence).look);
      }
      const iranLive = all.relays.some((p) => rowEvidence(p, evidence).look === "live");
      const iran = scene.lights.find((l) => l.cc === "ir");
      if (iranLive) expect(iran?.look).toBe("live");
    });
  }

  it("never counts a latency figure, an offline route or an unconfirmed landing as worked", () => {
    const ctx: EvidenceContext = { history: history(["de-wg", "WIREGUARD", false, HOUR], ["gb-r", "XRAY_VLESS_REALITY", true, HOUR]), network: NET, now: NOW };
    const inputs = { ownAt: (r: RouteOption) => ownWorkedAt(r, ctx), tags: true };
    expect(routeWorked(DE_WG, inputs)).toBe(false);
    // Offline: whatever it did before.
    expect(routeWorked(GB, inputs)).toBe(false);
    // Others' reports count only while they are about this network.
    expect(routeWorked(DE_WS, inputs)).toBe(true);
    expect(routeWorked(DE_WS, { ...inputs, tags: false })).toBe(false);
  });
});

describe("latency", () => {
  it("knows which protocols only a ping can time", () => {
    expect(udpOnly(DE_WG)).toBe(true);
    expect(udpOnly(TR)).toBe(true);
    expect(udpOnly(route("o", "de-germany", "OPENVPN"))).toBe(true);
    expect(udpOnly(route("o", "de-germany", "OPENVPN", { transport: "TCP" }))).toBe(false);
    expect(udpOnly(DE_WS)).toBe(false);
  });

  it("gives a place its best measured figure, and nothing when none was measured", () => {
    const place = { routes: [DE_WS, DE_WG] };
    expect(bestLatency(place, {})).toBeNull();
    expect(bestLatency(place, { "de-ws": null, "de-wg": null })).toBeNull();
    expect(bestLatency(place, { "de-ws": 120, "de-wg": 80 })).toBe(80);
  });
});
