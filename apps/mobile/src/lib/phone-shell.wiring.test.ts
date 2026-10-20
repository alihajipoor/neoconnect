import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { transitionKey } from "@shared/lib/shell-nav";

/* ------------------------------------------------------------------ *
 * Back to the main page from another page of the shell, on the phone.
 *
 * The Windows client unmounted its Dashboard for Settings, Activity,
 * Plans, Support and Invite friends and mounted it anew on the way back:
 * every return put "Loading..." over the whole window, then "Connected,
 * not confirmed", no route and no location list for seconds, over a
 * tunnel that never changed (VM, 2026-10-20). The phone app drew the same
 * pages the same way, and had the same cause. It now draws them as
 * Windows does: in the Dashboard's own shell, the Dashboard staying
 * mounted under them, what it shows asked for again behind it.
 *
 * Read from the source, as the phone's other wiring is: the screens need a
 * Tauri runtime. Not checked on a phone.
 * ------------------------------------------------------------------ */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const app = read("../App.tsx");
const dashboard = read("../screens/Dashboard.tsx");

describe("the phone app's shell", () => {
  it("draws every page of the shell through the one Dashboard, never a shell of its own", () => {
    expect(app.match(/<Dashboard\b/g)).toHaveLength(1);
    expect(app).toContain("page={shellPage()}");
    expect(app).toContain('onShowMain={() => setScreen("dashboard")}');
    expect(app).not.toMatch(/<AppShell\b/);
    expect(app).not.toContain("inShell(");
    expect(app).toContain("<ScreenTransition screenKey={transitionKey(screen)} viewTransitions>");
    for (const screen of ["dashboard", "settings", "activity", "plans", "referrals", "support"]) {
      expect(transitionKey(screen), screen).toBe("dashboard");
    }
  });

  it("animates a change between the shell's pages itself, as a change of view", () => {
    const go = app.slice(app.indexOf("  const go = (next: Screen) => {"), app.indexOf("  const shellPage = ("));
    expect(go).toContain("if (isSignedInScreen(from) && isSignedInScreen(next)) {");
    expect(go).toContain("swapView(() => setScreen(next), screenDirection(from, next));");
    const pages = app.slice(app.indexOf("  const shellPage = ("), app.indexOf("  function renderScreen() {"));
    expect(pages).not.toMatch(/setScreen\("(dashboard|settings|activity|plans|referrals|support)"\)/);
    // The store build's gate on the purchase path, kept.
    expect(pages).toContain('if (screen === "plans" && !IS_STORE_BUILD) {');
    expect(pages).toContain('if (screen === "plans" && IS_STORE_BUILD) {');
  });

  it("puts the load in front of the main page only, and only before its first answer", () => {
    expect(dashboard).toContain("if (loading && onMainPage) {");
    expect(dashboard).not.toMatch(/\n  if \(loading\) \{\n    return/);
  });

  it("draws a page in its own shell in place of the main page, which wears the pages' quiet look", () => {
    expect(dashboard).toContain('active={page ? page.nav : view === "locations" ? "locations" : "overview"}');
    expect(dashboard).toContain('shown={page ? "idle" : calmTone}');
    expect(dashboard).toContain("busy={page ? false : pill.progress}");
    expect(dashboard).toContain("banner={page ? false : bannerShowing}");
    expect(dashboard).toMatch(/\{page \? \(\s*<Fragment key=\{page\.key\}>\{page\.node\}<\/Fragment>\s*\) : view === "locations" \? \(/);
    expect(dashboard).toContain('page || view === "locations" ? (\n          <PageScene />');
    expect(dashboard).toContain('layout === "narrow" && view === "overview" && !page ? (');
  });

  it("goes back from a page in one transition, the view and the page together", () => {
    const at = dashboard.indexOf("  function showMainFrom(");
    expect(at).toBeGreaterThan(0);
    const back = dashboard.slice(at, dashboard.indexOf("\n  }\n", at));
    expect(back).toMatch(/swapView\(\(\) => \{[\s\S]*setViewNow\(next\);\s*onShowMain\?\.\(\);\s*\}, "back"\);/);
    expect(dashboard).toContain('onLocations={() => (page ? showMainFrom("locations") : openLocationsPage())}');
    expect(dashboard).toMatch(/if \(page\) showMainFrom\("overview"\);/);
    expect(dashboard).toContain("if (!loading && onMainPage && takeLocationsRequest()) openLocationsPage();");
  });

  it("asks again behind the main page on the way back, never in front of it", () => {
    const effect = dashboard.slice(dashboard.indexOf("  const onMainPageRef = useRef(onMainPage);"));
    expect(effect.slice(0, 400)).toMatch(/if \(was \|\| !onMainPage \|\| loading\) return;\s*offlineRetry\.revalidate\(\);/);
    // An unanswered ask leaves the screen's own last answer up, unbannered,
    // before anything would start the retrying.
    const load = dashboard.slice(dashboard.indexOf("  async function loadScreen("));
    expect(load).toContain('const keptAnswer = retry === "returned" && offlineSinceRef.current === null;');
    expect(load.indexOf('if (keptAnswer) return "unanswered";')).toBeGreaterThan(0);
    expect(load.indexOf('if (keptAnswer) return "unanswered";')).toBeLessThan(load.indexOf("offlineRetry.start();"));
    // The credential held stays while it is listed, dialled or up; one the
    // answer no longer lists is chosen again.
    expect(load).toContain("const heldListed = usersResult.data.some((u) => u.id === protocolUserRef.current?.id);");
    expect(load).toContain('retry !== "returned" || heldListed || passInFlight() || isTunnelUp(connectionStateRef.current);');
    expect(load).toContain("if (shownWhileWaiting && keepHeld) {");
  });
});
