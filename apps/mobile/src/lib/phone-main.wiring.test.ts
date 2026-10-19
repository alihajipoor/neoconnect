import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The phone's main page in Pearl Glass (design-system.md, phase 1 for the
 * mobile app), read from the source: the screen has no harness of its own,
 * and what is pinned here is what must not quietly change -- the calm hold,
 * the honest words, the store gates, the disclosure. */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const dashboard = read("../screens/Dashboard.tsx");
const app = read("../App.tsx");
const body = (start: string) => {
  const at = dashboard.indexOf(start);
  expect(at, start).toBeGreaterThan(0);
  return dashboard.slice(at, dashboard.indexOf("\n  }\n", at));
};

describe("the phone's main page", () => {
  it("is the shared shell and main view, with the bottom nav", () => {
    expect(dashboard).toMatch(/<AppShell\s/);
    expect(dashboard).toMatch(/<MainView\s/);
    expect(dashboard).toContain("onOpenActivity={onOpenActivity}");
    // The one location list: a sheet on a phone, the panel on a tablet.
    expect(dashboard).toContain('variant={view === "locations" ? "page" : layout === "narrow" ? "sheet" : "panel"}');
    expect(dashboard.split("<LocationPicker").length - 1).toBe(1);
  });

  it("hands the button the held look, not the raw state", () => {
    expect(dashboard).toMatch(/<ConnectOrb\s+state=\{orbState\}\s+caution=\{cautionShown\}/);
    expect(dashboard).toContain('look="pill"');
    expect(dashboard).toMatch(/orbHold\.observe\(connectionState, \{[\s\S]{0,400}pressed,\s*caution,/);
    expect(dashboard).toContain("reconnecting: reconnectingView(autoReconnect.current(), sessionGeneration()) !== null,");
    expect(dashboard).toContain("setCautionShown(orbHold.caution());");
    // The phone has no "not fully protected" condition to colour.
    expect(dashboard).toContain('orbCaution.observe({ state: connectionState, unconfined: false, byChoice: false })');
  });

  it("colours the chip and the screen by the button's own held tone", () => {
    expect(dashboard).toContain("const calmTone = shownTone(orbTone(orbState, cautionShown), ");
    expect(dashboard).toContain("shown={calmTone}");
    expect(dashboard).not.toMatch(/shownTone\(orbTone\(connectionState/);
  });

  it("marks every press of the customer's before it acts", () => {
    expect(body("async function handleConnectToggle() {").slice(0, 200)).toContain("setPressed(true);");
    expect(body("async function connectNow(takeover?: string[]) {").slice(0, 200)).toContain("setPressed(true);");
  });

  it("says the state from the shared tables, and the address only once verified", () => {
    expect(dashboard).toContain("const chip = chipFor(connectionState, headline, { teardownShowing });");
    expect(dashboard).toContain("const line = lineFor(connectionState, headline, { connectedAt, teardownShowing });");
    expect(dashboard).toContain("const pill = pillFor(connectionState, press, { pressed, teardownShowing, failed });");
    expect(dashboard).toContain("const ip = ipFor(connectionState, exitIp, { gaming: false });");
    // The timer and the check exist only for verified traffic (hero-model):
    // nothing here draws either from anything else.
    expect(dashboard).not.toMatch(/formatDuration\(/);
    expect(dashboard).toContain("<StatusChip glyph={chip.glyph} label={t(chip.labelKey)} />");
  });

  it("speaks of this device and a tap, not a computer and a click", () => {
    expect(dashboard).toContain('"dash.verifyingHint": "dash.verifyingHintPhone",');
    expect(dashboard).toContain('"dash.waitingForNetworkHint": "dash.waitingForNetworkHintPhone",');
    expect(dashboard).toContain("t(phoneHint(headline.hint))");
    expect(dashboard).toContain("reserve={PHONE_HEADLINE_HINTS}");
  });

  it("changes location only with nothing up, as it always has, and says why", () => {
    const confirm = body("async function confirmPick(): Promise<boolean> {");
    expect(confirm).toContain('if (connectionStateRef.current === "disconnected") return true;');
    expect(confirm).toContain("setAskDisconnect(true);");
    expect(confirm).toContain("return false;");
    expect(dashboard).toContain("confirmPick={confirmPick}");
    expect(dashboard).toContain('title={t("dash.disconnectToChange")}');
  });

  it("offers to buy only where this build may sell (App Store 3.1.1; Google Play's build sells nothing)", () => {
    expect(dashboard).toContain("const canBuy = !IS_STORE_BUILD || iapAvailable();");
    expect(dashboard).toMatch(/renew:\s*offlineSince === null && canBuy\s*\?/);
    expect(dashboard).toMatch(/\) : canBuy \? \(\s*\/\/[^\n]*\n\s*<div className="nx-actions">\s*<PillButton onClick=\{onBrowsePlans\}>\{t\("dash\.viewPlans"\)\}/);
    expect(dashboard).toContain('{IS_STORE_BUILD && !iapAvailable() ? t("dash.noPlanStore") : t("dash.noPlanHint")}');
    // The plan that ended offers renewal only as `endedNotice` allows.
    expect(dashboard).toContain("endedNotice(subscription.status, IS_STORE_BUILD, iapAvailable())");
    expect(dashboard).toContain("{endedState.showPlansButton ? (");
  });

  it("chooses the sheet or the panel by the app root's width, as the stylesheet does, not the window's", () => {
    // #root pads the side insets on a phone on its side: the window is
    // wider than the box the container queries measure.
    expect(dashboard).toContain("const layout = useAppLayout(appRootRef);");
    expect(dashboard).toMatch(/<AppShell\s+rootRef=\{appRootRef\}/);
    expect(dashboard).not.toContain("useWindowLayout");
    const hook = read("./app-layout.ts");
    expect(hook).toContain("return useLayoutMode(ref, initial);");
    expect(hook).toContain('document.getElementById("root")');
  });

  it("says a declined VPN prompt in the platform's own words", () => {
    expect(dashboard).toContain('t(isIOS() ? "dash.vpnPermissionDeniedIos" : "dash.vpnPermissionDenied")');
    expect(dashboard).not.toMatch(/t\("dash\.vpnPermissionDenied"\)/);
    const i18n = read("../../../desktop-windows/src/lib/i18n.tsx");
    const lines = (key: string) => i18n.split("\n").flatMap((line, i, all) => (line.includes(`"${key}":`) ? [line + all[i + 1]] : []));
    const android = lines("dash.vpnPermissionDenied");
    const ios = lines("dash.vpnPermissionDeniedIos");
    // English and Persian, each.
    expect(android).toHaveLength(2);
    expect(ios).toHaveLength(2);
    expect(android[0]).toContain("Android");
    expect(android[0]).toContain("choose OK");
    expect(ios[0]).toContain("iOS");
    expect(ios[0]).toContain("choose Allow");
    expect(ios[0]).not.toContain("Android");
    expect(ios[1]).not.toContain("اندروید");
    expect(ios[1]).toContain("Allow");
  });

  it("lights the map only on this network's evidence, read since the phone may last have moved", () => {
    expect(dashboard).toContain("const mapNetworkId = reading !== null && reading.at >= roamedAt ? networkKeyFromAsn(now) : null;");
    expect(dashboard).toContain("const mapRoutes = tagsNow ? routes : withoutTags(routes);");
    expect(dashboard).toMatch(/mapLights\(\{\s*routes: mapRoutes,\s*\.\.\.evidenceCtx,\s*verified: verifiedShown,\s*tone: calmTone,/);
  });
});

describe("the phone's own look", () => {
  it("is Pearl Glass throughout: the old violet set is gone", () => {
    expect(app).not.toMatch(/legacy/i);
    expect(read("../globals.css")).not.toContain("legacy-theme.css");
    expect(existsSync(new URL("../../../desktop-windows/src/legacy-theme.css", import.meta.url))).toBe(false);
  });

  it("keeps per-app routing on Android, and only there", () => {
    expect(app).toContain("customSection={isAndroid() ? <PerAppCard /> : null}");
  });

  it("keeps the status bar and the home indicator clear on a tablet and a phone on its side", () => {
    const phone = read("../phone.css");
    // The status bar's inset stands in for the Windows title strip, which
    // the medium and wide layouts pad their tops by.
    expect(phone).toMatch(/\.nx-app \{\s*--tb: var\(--safe-t\);\s*\}/);
    expect(phone).toMatch(/@container app \(min-width: 640px\) \{\s*\.nx-auth-scroll \{\s*padding-bottom: var\(--safe-b\);/);
    expect(phone).toMatch(/\.nx-ov \{\s*padding-bottom: calc\(16px \+ var\(--safe-b\)\);/);
    expect(phone).toMatch(/\.nx-ov \{\s*padding-bottom: calc\(18px \+ var\(--safe-b\)\);/);
    expect(phone).toMatch(/\.nx-side \{\s*padding-bottom: calc\(14px \+ var\(--safe-b\)\);/);
    expect(phone.match(/\.nx-pinner \{\s*padding-bottom: calc\(\d+px \+ var\(--safe-b\)\);/g)).toHaveLength(2);
  });

  it("draws the status bar's inset once under the backup-route chip", () => {
    // pearl.css declares --safe-t on .nx-app in its components layer: a
    // layered override loses to it whatever its specificity, so the chip
    // row's rules are unlayered.
    const globals = read("../globals.css");
    const layered = (css: string) => {
      const spans: [number, number][] = [];
      for (const m of css.matchAll(/@layer [\w-]+\s*\{/g)) {
        let depth = 0;
        for (let i = m.index! + m[0].length - 1; i < css.length; i++) {
          if (css[i] === "{") depth++;
          else if (css[i] === "}" && --depth === 0) {
            spans.push([m.index!, i]);
            break;
          }
        }
      }
      return (at: number) => spans.some(([a, b]) => at > a && at < b);
    };
    const inLayer = layered(globals);
    for (const rule of [".nx-relayrow:not(:empty) {", ".nx-relayrow:not(:empty) + .nx-screen .nx-app {"]) {
      const at = globals.indexOf(rule);
      expect(at, rule).toBeGreaterThan(0);
      expect(inLayer(at), rule).toBe(false);
    }
    expect(globals).toMatch(/\.nx-relayrow:not\(:empty\) \+ \.nx-screen \.nx-app \{\s*--safe-t: 0px;/);
    expect(app).toMatch(/<div className="nx-relayrow">\s*<BackupRouteChip \/>\s*<\/div>\s*<div className="nx-screen /);
  });

  it("outlines an unchosen app's box at 3:1, with the fields' outline", () => {
    expect(read("../phone.css")).toMatch(/\.nx-perapp-row \.box \{[^}]*box-shadow: inset 0 0 0 1\.5px var\(--field-line\);/);
  });
});

describe("the first-run disclosure Google Play requires", () => {
  const disclosure = read("../components/ProminentDisclosure.tsx");

  it("is still shown before anything else, a signed-in session included", () => {
    const effect = app.slice(app.indexOf("if (!(await hasAcceptedDisclosure())) {"));
    expect(effect.indexOf('setScreen("disclosure");')).toBeGreaterThan(0);
    expect(effect.indexOf('setScreen("disclosure");')).toBeLessThan(effect.indexOf("await getTokens()"));
    expect(app).toContain("return <ProminentDisclosure onAccept={() => void afterDisclosure()} />;");
  });

  it("says the same things in the same order", () => {
    const order = [
      't("disclosure.title")',
      't("disclosure.subtitle")',
      't("disclosure.vpnHeading")',
      't("disclosure.vpnBody")',
      't("disclosure.vpnBody2")',
      't("disclosure.dataHeading")',
      '"disclosure.dataEmail"',
      '"disclosure.dataSupport"',
      '"disclosure.dataDiagnostics"',
      '"disclosure.dataServerLogs"',
      't("disclosure.dataNotSold")',
      't("disclosure.privacyLink")',
      't("disclosure.accept")',
    ];
    const at = order.map((key) => disclosure.indexOf(key));
    for (const [i, key] of order.entries()) expect(at[i], key).toBeGreaterThan(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("is accepted only by its button, and only once the acceptance is written", () => {
    expect(disclosure.split("onAccept()").length - 1).toBe(1);
    expect(disclosure).toMatch(/setPending\(true\);\s*await recordAcceptance\(\);\s*onAccept\(\);/);
    expect(disclosure).toContain("onClick={() => void accept()}");
    expect(disclosure).toContain("export const DISCLOSURE_VERSION = 1;");
  });
});
