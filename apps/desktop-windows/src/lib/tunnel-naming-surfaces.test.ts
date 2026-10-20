import { readFileSync } from "node:fs";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocationList } from "../components/LocationList";
import type { ConnectionState } from "../components/ConnectOrb";
import { displayedProtocol, displayedRoute, displayedRouteId } from "./displayed-route";
import { I18nProvider } from "./i18n";
import { mapLights } from "./map-lights";
import type { RouteOption } from "./types";

/* ------------------------------------------------------------------ *
 * Hotfix 0.9.52 on the redesign's own surfaces.
 *
 * Seen on the VM: connected to Singapore on Stealth, then Settings and
 * back, and the screen named the pin -- the UK on Stealth Web. The screen
 * holds the pin's credential after every load; it says which credential
 * the tunnel is on only once a pass of its own, or a read of the service,
 * has named it (`tunnelNamed`, lib/tunnel-credential.ts). The tiles of
 * 0.9.52 show "—" until then. The redesign names the route in more places
 * than tiles: the location card and tray, the map's connected light and
 * its halo, the list's "Connected here", and the session log. Each must
 * name the tunnel's route, or nothing -- never the pin.
 *
 * The main pages need a Tauri runtime, a service and a network, so their
 * chain is played here through the same functions they call, and their
 * wiring is pinned by source below.
 * ------------------------------------------------------------------ */

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

const ROUTES: RouteOption[] = [
  route("uk-web", "gb-united-kingdom", "XRAY_VLESS_TLS", { transport: "WS" }),
  route("sg-reality", "sg-singapore", "XRAY_VLESS_REALITY"),
  route("de-reality", "de-germany", "XRAY_VLESS_REALITY"),
];
const ukWeb = { id: "pu-uk-web", routeId: "uk-web", protocol: "XRAY_VLESS_TLS" as const, connection: { transport: "WS" } };
const sgStealth = { id: "pu-sg", routeId: "sg-reality", protocol: "XRAY_VLESS_REALITY" as const, connection: {} };
const held = [ukWeb, sgStealth];
const PIN = ukWeb.routeId;

/** What a main page derives, as both Dashboards derive it: the route the
 * card, the tray and the map name (`currentRoute`), the row the list marks
 * (`screenRouteId`), and the protocol the card names (`shownProtocol`).
 * `holding` is the credential on screen -- the pin's after a load, the
 * tunnel's once something named it. */
function screen(state: ConnectionState, holding: typeof ukWeb | typeof sgStealth, named: boolean) {
  return {
    currentRoute: displayedRoute(ROUTES, state, holding.routeId, PIN, holding.routeId, named),
    screenRouteId: displayedRouteId(state, holding.routeId, PIN, holding.routeId, named),
    shownProtocol: displayedProtocol(state, holding, PIN, held, ROUTES, named),
  };
}

/** The map as the main pages feed it: the verified place, the route the
 * tunnel settled on, under the verified tone. */
function mapFor(currentRoute: RouteOption | null) {
  return mapLights({
    routes: ROUTES,
    history: {},
    network: null,
    now: 0,
    verified: currentRoute,
    tone: "ok",
    shown: currentRoute,
    up: currentRoute,
    drawable: () => true,
  });
}

type ListProps = ComponentProps<typeof LocationList>;

/** The list as the picker draws it: with a location pinned, the row it
 * marks is the one the main page names (`LocationPicker`: `pinnedRouteId =
 * automatic ? undefined : currentRouteId`). */
function listFor(currentRouteId: string | undefined, state: ConnectionState): string {
  const props: ListProps = {
    variant: "panel",
    routes: ROUTES,
    latencies: {},
    measuring: false,
    measuredAt: null,
    tunnelActive: true,
    connectionState: state,
    pinnedRouteId: currentRouteId,
    currentRouteId,
    automatic: false,
    showAutomatic: true,
    switchingId: null,
    onPick: () => undefined,
    onAutomatic: () => undefined,
    onMeasure: () => undefined,
  };
  return renderToStaticMarkup(createElement(I18nProvider, null, createElement(LocationList, props)));
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("a tunnel the screen cannot name, on the redesign's surfaces", () => {
  it("names no place and no protocol on the card and the tray, and marks no row, in every state a tunnel is up", () => {
    for (const state of ["connected", "verifying", "unverified", "degraded"] as const) {
      const shown = screen(state, ukWeb, false);
      expect(shown.currentRoute, state).toBeNull();
      expect(shown.screenRouteId, state).toBeNull();
      expect(shown.shownProtocol, state).toBeNull();
    }
  });

  it("draws no connected light and no halo, where 0.9.51's rule lit the pin", () => {
    const unnamed = mapFor(screen("connected", ukWeb, false).currentRoute);
    expect(unnamed.lights.some((light) => light.exit)).toBe(false);
    // The rule before the hotfix: the pin's country carried the halo over a
    // tunnel to Singapore.
    const before = mapFor(screen("connected", ukWeb, true).currentRoute);
    expect(before.lights.filter((light) => light.exit).map((light) => light.cc)).toEqual(["gb"]);
  });

  it("says no \"Connected here\" and no \"In use\" anywhere in the list", () => {
    for (const state of ["connected", "unverified"] as const) {
      const html = listFor(screen(state, ukWeb, false).screenRouteId ?? undefined, state);
      expect(text(html), state).not.toContain("Connected here");
      expect(text(html), state).not.toContain("In use");
      // Nor is the pin's row the selected one.
      expect(html, state).not.toMatch(/nx-prow sel/);
    }
  });

  it("names the tunnel's own route everywhere once a read has named it", () => {
    const shown = screen("connected", sgStealth, true);
    expect(shown.currentRoute?.id).toBe("sg-reality");
    expect(shown.screenRouteId).toBe("sg-reality");
    expect(shown.shownProtocol).toEqual({ protocol: "XRAY_VLESS_REALITY", transport: undefined });
    expect(mapFor(shown.currentRoute).lights.filter((light) => light.exit).map((light) => light.cc)).toEqual(["sg"]);
    const html = listFor(shown.screenRouteId ?? undefined, "connected");
    expect(text(html)).toContain("Connected here");
    expect(html.match(/data-row="r:sg-reality"[^>]*class="nx-row nx-prow sel"|class="nx-row nx-prow sel"[^>]*data-row="r:sg-reality"/)).not.toBeNull();
  });

  it("still names the pin while nothing is up: the card is then a promise about the next connect", () => {
    const shown = screen("disconnected", ukWeb, false);
    expect(shown.currentRoute?.id).toBe("uk-web");
    expect(shown.screenRouteId).toBe("uk-web");
    expect(shown.shownProtocol).toEqual({ protocol: "XRAY_VLESS_TLS", transport: "WS" });
  });
});

const desktop = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
const phone = readFileSync(new URL("../../../mobile/src/screens/Dashboard.tsx", import.meta.url), "utf8");
const phoneExtras = readFileSync(new URL("../../../mobile/src/lib/phone-main-extras.ts", import.meta.url), "utf8");
const activity = readFileSync(new URL("../screens/Activity.tsx", import.meta.url), "utf8");

describe("both main pages feed their surfaces the tunnel's naming", () => {
  for (const [name, source] of [
    ["Windows", desktop],
    ["phone", phone],
  ] as const) {
    it(`${name}: the card, the tray, the map and the list take the rule that knows`, () => {
      expect(source).toContain("const tunnelNamed = !tunnelRouteUnknown;");
      expect(source).toMatch(
        /displayedRoute\(\s*routes,\s*connectionState,\s*protocolUser\?\.routeId,\s*chosenRouteId,\s*protocolUser\?\.routeId,\s*tunnelNamed,?\s*\)/,
      );
      expect(source).toContain(
        "const screenRouteId = displayedRouteId(connectionState, protocolUser?.routeId, chosenRouteId, protocolUser?.routeId, tunnelNamed);",
      );
      expect(source).toContain(
        "const shownProtocol = displayedProtocol(connectionState, protocolUser, chosenRouteId, protocolUsers, routes, tunnelNamed);",
      );
      // The location card and the tray: the place, or "—".
      expect(source).toContain('name: automaticPending ? t("loc.automaticShort") : currentRoute ? placeLabel(currentRoute, language) : "—",');
      expect(source).toContain("const protocolName = shownProtocol ? customerProtocolLabel(shownProtocol.protocol, shownProtocol.transport) : null;");
      // The list's "Connected here": the row the card names, never the
      // credential held.
      expect(source).toContain("currentRouteId={screenRouteId ?? undefined}");
      expect(source).not.toMatch(/currentRouteId=\{protocolUser/);
      // The map's connected light and halo: only the route named.
      expect(source).toMatch(/verifiedRouteRef\.current = currentRoute;/);
      expect(source).not.toMatch(/verifiedRouteRef\.current = (?!currentRoute;)/);
      expect(source).not.toMatch(/(verified|up|shown): [^,\n]*protocolUser/);
    });
  }

  it("Windows: the session log records the credential the tunnel is on, or none", () => {
    expect(desktop).toContain("const user = loggedCredential(protocolUserRef.current, tunnelNamedRef.current);");
    expect(desktop).toContain("const moved = movedRoute(open, user);");
    expect(desktop).toContain("tunnelNamedRef.current = tunnelNamed;");
  });

  it("phone: the session log, once the main page calls it, takes the same comparison", () => {
    expect(phoneExtras).toContain("const moved = movedRoute(open, user);");
  });

  it("the log says a record with no route as the card does, not as a place no longer listed", () => {
    expect(activity).toContain('const place = route ? placeLabel(route, language) : record.routeId === null ? "—" : t("act.unlisted");');
  });
});
