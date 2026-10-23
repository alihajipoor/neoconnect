import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isSignedInScreen, SIGNED_IN_SCREENS, transitionKey } from "./shell-nav";

/* ------------------------------------------------------------------ *
 * Back to the main page from another page of the shell (VM, 2026-10-20).
 *
 * The Dashboard was a screen of its own, unmounted for Settings,
 * Activity, Plans, Support and Invite friends, and mounted anew on the way
 * back -- so every return put "Loading..." over the whole window, sidebar
 * and all, for 1.4-1.8 s while the plan was fetched again, then "Connected,
 * not confirmed", "-- Stealth", "The list of locations hasn't loaded" and
 * no address for another 1-2 s, over a tunnel that had not changed. It was
 * back to verified 2.6-3.4 s after the click.
 *
 * Now the Dashboard draws the other pages itself, in its own shell, in
 * place of the main page, and stays mounted under them: what it loaded and
 * verified is there on the way back, and what it shows is asked for again
 * behind it (offline-retry.test.ts, "asking again on coming back"). The
 * screens need a Tauri runtime, so their wiring is pinned from source, as
 * in dashboard-remount.test.ts.
 * ------------------------------------------------------------------ */

/** How many times the Dashboard is mounted over a walk through the app:
 * once at the start, and once more every time the transition between
 * screens changes its key -- a new key is a new subtree. */
function dashboardMounts(walk: string[], keyOf: (screen: string) => string): number {
  let mounts = 0;
  let shown: string | null = null;
  for (const screen of walk) {
    const key = keyOf(screen);
    if (key !== shown && key === "dashboard") mounts += 1;
    shown = key;
  }
  return mounts;
}

const WALK = ["dashboard", "settings", "dashboard", "activity", "dashboard", "plans", "dashboard", "settings", "referrals", "settings", "support", "dashboard"];

describe("a walk through the shell's pages", () => {
  it("mounts the main page's screen once, however many pages are visited", () => {
    // As it was: the transition was keyed by the screen itself.
    expect(dashboardMounts(WALK, (screen) => (screen === "dashboard" ? "dashboard" : screen))).toBe(5);
    expect(dashboardMounts(WALK, transitionKey)).toBe(1);
  });

  it("keys every page of the signed-in shell as the main page, and nothing else", () => {
    for (const screen of ["dashboard", "settings", "activity", "plans", "referrals", "support"]) {
      expect(isSignedInScreen(screen), screen).toBe(true);
      expect(transitionKey(screen), screen).toBe("dashboard");
    }
    for (const screen of ["loading", "signingOut", "login", "register", "forgot", "verify", "disclosure"]) {
      expect(isSignedInScreen(screen), screen).toBe(false);
      expect(transitionKey(screen), screen).toBe(screen);
    }
    expect(SIGNED_IN_SCREENS).toHaveLength(6);
  });

  it("still mounts it afresh after a sign-out and a sign-in", () => {
    expect(dashboardMounts(["dashboard", "settings", "signingOut", "login", "dashboard"], transitionKey)).toBe(2);
  });
});

describe("the desktop app's wiring", () => {
  const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
  const body = (source: string, signature: string) => {
    const start = source.indexOf(signature);
    expect(start, signature).toBeGreaterThan(0);
    return source.slice(start, source.indexOf("\n  }\n", start));
  };

  it("draws every page of the shell through the one Dashboard, never a shell of its own", () => {
    expect(app.match(/<Dashboard\b/g)).toHaveLength(1);
    expect(app).toContain("page={shellPage()}");
    expect(app).toContain('onShowMain={() => setScreen("dashboard")}');
    expect(app).not.toMatch(/<AppShell\b/);
    expect(app).not.toContain("inShell(");
    expect(app).toContain("<ScreenTransition screenKey={transitionKey(screen)} viewTransitions>");
  });

  it("animates a change between the shell's pages itself, as a change of view", () => {
    const go = app.slice(app.indexOf("  const go = (next: Screen) => {"), app.indexOf("  const shellPage = ("));
    expect(go).toContain("if (isSignedInScreen(from) && isSignedInScreen(next)) {");
    expect(go).toContain("swapView(() => setScreen(next), screenDirection(from, next));");
    // Every way between them goes through it.
    const pages = app.slice(app.indexOf("  const shellPage = ("), app.indexOf("  const renderScreen = () => {"));
    expect(pages).not.toMatch(/setScreen\("(dashboard|settings|activity|plans|referrals|support)"\)/);
  });

  it("puts the load in front of the main page only, and only before its first answer", () => {
    expect(dashboard).toContain("if (loading && onMainPage) {");
    expect(dashboard).not.toMatch(/\n  if \(loading\) \{\n    return/);
  });

  it("draws a page in its own shell in place of the main page, which wears the pages' quiet look", () => {
    expect(dashboard).toContain("active={page ? page.nav : view === \"locations\" ? \"locations\" : \"overview\"}");
    expect(dashboard).toContain('shown={page ? "idle" : calmTone}');
    expect(dashboard).toMatch(/\{page \? \(\s*<Fragment key=\{page\.key\}>\{page\.node\}<\/Fragment>\s*\) : view === "locations" \? \(/);
    expect(dashboard).toContain("page || view === \"locations\" ? (\n          <PageScene />");
    expect(dashboard).toContain('layout === "narrow" && view === "overview" && !page ? (');
  });

  it("goes back from a page in one transition, the view and the page together", () => {
    const back = body(dashboard, "  function showMainFrom(");
    expect(back).toMatch(/swapView\(\(\) => \{[\s\S]*setViewNow\(next\);\s*onShowMain\?\.\(\);\s*\}, "back"\);/);
    expect(dashboard).toContain('onLocations={() => (page ? showMainFrom("locations") : openLocationsPage())}');
    expect(dashboard).toMatch(/if \(page\) showMainFrom\("overview"\);/);
  });

  it("asks again behind the main page on the way back, never in front of it", () => {
    const effect = dashboard.slice(dashboard.indexOf("  const onMainPageRef = useRef(onMainPage);"));
    expect(effect.slice(0, 400)).toMatch(/if \(was \|\| !onMainPage \|\| loading\) return;\s*offlineRetry\.revalidate\(\);/);
    // The background load the retry makes: no loading screen, and the
    // service, the route memory and the baselines left to the polls.
    const load = body(dashboard, "  async function loadScreen(preferRouteId: string | undefined, retry: OfflineRetryTrigger | null): Promise<OfflineLoadOutcome> {");
    expect(load).toContain("const background = retry !== null;");
    expect(load).toMatch(/if \(!background\) \{\s*setLoading\(true\);/);
    expect(load).toContain("const adopted = shownWhileWaiting ? null : await adoptServiceState(sub, usersResult.data);");
    // An unanswered ask leaves the screen's own last answer up, unbannered.
    expect(load).toContain('const keptAnswer = retry === "returned" && offlineSinceRef.current === null;');
    expect(load).toContain('if (keptAnswer) return "unanswered";');
    expect(load.indexOf('if (keptAnswer) return "unanswered";')).toBeLessThan(load.indexOf("offlineRetry.start();"));
  });

  it("reads Custom mode's saved setting again whenever the main page comes back", () => {
    const at = dashboard.indexOf("loadSplitTunnel()");
    const effect = dashboard.slice(dashboard.lastIndexOf("useEffect(() => {", at), dashboard.indexOf("}, [onMainPage]);", at) + 20);
    expect(effect).toContain("if (!onMainPage) return;");
    expect(effect).toContain("}, [onMainPage]);");
  });
});
