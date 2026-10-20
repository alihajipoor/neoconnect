import { describe, expect, it, vi } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocationList, twinNumber } from "../components/LocationList";
import { I18nProvider } from "./i18n";
import type { RouteOption } from "./types";

/** The redesigned list as it renders (components/LocationList.tsx): every
 * protocol is there to open, latency says what the test saw and never more,
 * and the list is one tab stop. Drawn without effects, so what is pinned is
 * the first frame -- countries closed, nothing searched. */

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
  route("de-ws", "de-germany", "XRAY_VLESS_TLS", { transport: "WS", ispTag: { code: "worksOnYourIsp", customers: 9, outOf: 11, windowHours: 24 } }),
  route("de-wg", "de-germany", "WIREGUARD"),
  route("fi-r", "fi-finland", "XRAY_VLESS_REALITY"),
  route("gb-r", "gb-united-kingdom", "XRAY_VLESS_REALITY", { nodeStatus: "OFFLINE" }),
  route("tr-ike", "tr-turkey", "IKEV2"),
  route("ir-de", "ir-iran", "XRAY_VLESS_TLS", { isRelay: true, transport: "WS", exitLocation: { region: "de-germany" } }),
];

type Props = ComponentProps<typeof LocationList>;
const noop = () => undefined;

function render(over: Partial<Props> = {}): string {
  const props: Props = {
    variant: "panel",
    routes: ROUTES,
    latencies: {},
    measuring: false,
    measuredAt: null,
    tunnelActive: false,
    automatic: true,
    showAutomatic: true,
    switchingId: null,
    onPick: noop,
    onAutomatic: noop,
    onMeasure: noop,
    ...over,
  };
  return renderToStaticMarkup(createElement(I18nProvider, null, createElement(LocationList, props)));
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
const attr = (value: string) => value.replace(/>/g, "&gt;");

describe("the redesigned server list", () => {
  it("draws Automatic, one row per country and every protocol under it -- none dropped", () => {
    for (const variant of ["panel", "sheet", "page"] as const) {
      const html = render({ variant });
      expect(html, variant).toContain('data-row="auto"');
      for (const key of ["c:de", "c:fi", "c:gb", "c:tr", "r:ir>de"]) expect(html, `${variant} ${key}`).toContain(`data-row="${attr(`p:${key}`)}"`);
      for (const r of ROUTES) expect(html, `${variant} ${r.id}`).toContain(`data-row="r:${r.id}"`);
      // Countries start closed, their protocols out of the tab order.
      expect(html.match(/nx-crow" aria-expanded="false"/g)?.length, variant).toBe(5);
      expect(html.match(/<div inert=""/g)?.length, variant).toBe(5);
    }
  });

  it("is one tab stop: the selected row, else the first", () => {
    const html = render();
    expect(html.match(/tabindex="0"/g)?.length).toBe(1);
    expect(html).toMatch(/data-row="auto" tabindex="0"/);
    const pinned = render({ automatic: false, pinnedRouteId: "fi-r" });
    expect(pinned.match(/tabindex="0"/g)?.length).toBe(1);
    // A closed country holds the stop for the protocol picked in it.
    expect(pinned).toMatch(/data-row="p:c:fi" tabindex="0"/);
  });

  it("says what the timing test saw: a figure, Can't measure, Not measured or Offline -- never down or unreachable", () => {
    const html = text(render({ variant: "page", latencies: { "de-ws": 84, "de-wg": null, "ir-de": 34 } }));
    expect(html).toContain("84 ms");
    expect(html).toContain("Can't measure");
    // Fast is UDP: the reason says only a ping can time it.
    expect(text(render({ variant: "page", latencies: { "de-wg": null } }))).toContain("Only a ping can time this protocol");
    expect(html).toContain("Not measured");
    expect(html).toContain("Offline");
    // A relay's figure is to its entry in Iran only.
    expect(html).toContain("to Iran");
    expect(html).not.toMatch(/\b(down|unreachable|couldn't reach)\b/i);
  });

  it("says why it can't measure on the row where a touch has no hover: the sheet and the page", () => {
    // The sheet: the short reason, shown; the tooltip and the screen
    // reader's copy would only repeat it.
    const sheet = render({ variant: "sheet", latencies: { "de-wg": null, "tr-ike": null } });
    expect(text(sheet)).toContain("No answer to the ping. Many networks block pings; it may still connect.");
    expect(sheet).not.toMatch(/class="nx-cant"[^>]*title=/);
    // The page: the whole reason.
    expect(text(render({ variant: "page", latencies: { "de-ws": null } }))).toContain("The timing test got no answer.");
    // The panel, a desktop with a pointer: a tooltip and the screen reader's words.
    const panel = render({ variant: "panel", latencies: { "de-wg": null } });
    expect(panel).toMatch(/class="nx-cant" title="Only a ping can time this protocol/);
    expect(text(panel)).not.toContain("No answer to the ping.");
  });

  it("writes the figures in Persian digits in Persian, the latency left to right", () => {
    vi.stubGlobal("navigator", { language: "fa-IR", userAgent: "" });
    try {
      const html = render({ variant: "sheet", latencies: { "de-ws": 107 } });
      expect(html).toContain('dir="ltr">۱۰۷ ms</span>');
      expect(html).not.toContain("107 ms");
      // The counts behind "worked for others here" too.
      expect(html).toContain("۹ نفر از ۱۱ نفر، ۲۴ ساعت گذشته");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows no figure while a tunnel is up, and says why", () => {
    const html = text(render({ tunnelActive: true, connectionState: "connected", latencies: { "de-ws": 84 } }));
    expect(html).not.toContain("84 ms");
    expect(html).not.toContain("Not measured");
    expect(html).toContain("Latency is measured while you're disconnected.");
  });

  it("says Connected here only over verified traffic, In use over a tunnel not proven", () => {
    const base = { automatic: false, pinnedRouteId: "de-ws", currentRouteId: "de-ws", tunnelActive: true };
    expect(text(render({ ...base, connectionState: "connected" }))).toContain("Connected here");
    const unverified = text(render({ ...base, connectionState: "unverified" }));
    expect(unverified).toContain("In use");
    expect(unverified).not.toContain("Connected here ·");
    const connecting = text(render({ ...base, connectionState: "connecting" }));
    expect(connecting).not.toContain("In use");
  });

  it("gives the Locations page each protocol's plain-language hint, in both columns", () => {
    const html = text(render({ variant: "page" }));
    expect(html).toContain("Looks like ordinary web traffic.");
    expect(html).toContain("Hardest to block.");
    expect(html).toContain("Uses your device's own VPN.");
    expect(html).toContain("How the protocols differ");
  });

  it("names the routes through Iran as such", () => {
    const html = text(render());
    expect(html).toContain("Through Iran");
    expect(html).toContain("Via Iran");
    expect(html).toContain("Iran → Germany");
  });

  it("tells two servers with one protocol in one place apart as Server 1 and 2, never by the node's own name", () => {
    const twins = [
      { ...ROUTES[0], location: { region: "de-germany", nodeName: "germany-1" } },
      ...ROUTES.slice(1),
      route("de-ws-2", "de-germany", "XRAY_VLESS_TLS", { transport: "WS", location: { region: "de-germany", nodeName: "germany-2" } }),
    ];
    for (const variant of ["panel", "sheet", "page"] as const) {
      const html = text(render({ variant, routes: twins }));
      expect(html, variant).toContain("Server 1");
      expect(html, variant).toContain("Server 2");
      expect(html, variant).not.toMatch(/germany-[12]|node-/);
    }
    // A protocol with one server in its place carries no number.
    expect(text(render())).not.toMatch(/Server \d/);
  });
});

describe("twinNumber", () => {
  const label = (r: RouteOption) => r.protocol;
  const at = (id: string, node: string, protocol: RouteOption["protocol"] = "WIREGUARD") =>
    route(id, "de-germany", protocol, { location: { region: "de-germany", nodeName: node } });

  it("numbers by the node's name, however the list arrives", () => {
    const a = at("x", "germany-10");
    const b = at("y", "germany-2");
    const c = at("z", "germany-1");
    for (const order of [
      [a, b, c],
      [c, b, a],
      [b, a, c],
    ]) {
      expect(twinNumber(order, c, label)).toBe(1);
      expect(twinNumber(order, b, label)).toBe(2);
      expect(twinNumber(order, a, label)).toBe(3);
    }
  });

  it("is null for a protocol alone in its place, or offered only on one node", () => {
    const wg = at("wg", "germany-1");
    const tls = at("tls", "germany-2", "XRAY_VLESS_TLS");
    expect(twinNumber([wg, tls], wg, label)).toBeNull();
    const again = at("wg-b", "germany-1");
    expect(twinNumber([wg, again], wg, label)).toBeNull();
  });
});
