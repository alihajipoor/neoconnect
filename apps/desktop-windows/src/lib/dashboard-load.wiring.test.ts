import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** A start with Neoxify out of reach, on both clients' dashboards.
 *
 * Every address used to be given up on at eight seconds, and a start with
 * a cached snapshot was on the dashboard, Connect and all, by then. Reads
 * now wait twenty seconds an address, so on a network where every address
 * is blackholed the start sat on "Loading..." for eleven and a half
 * seconds, and for twenty-three where the filter lets the handshake
 * through and then stalls -- holding credentials that would have
 * connected. Read from the source, because the screens have no harness of
 * their own (see dashboard-remount.test.ts). */

const screens = [
  ["Windows", "../screens/Dashboard.tsx", "  async function loadScreen(preferRouteId: string | undefined, retry: OfflineRetryTrigger | null): Promise<boolean> {"],
  ["phone", "../../../mobile/src/screens/Dashboard.tsx", "  async function loadScreen(preferRouteId: string | undefined, ready: () => void, retry: OfflineRetryTrigger | null = null): Promise<boolean> {"],
] as const;

describe.each(screens)("the %s dashboard's first load", (_name, path, signature) => {
  const screen = readFileSync(new URL(path, import.meta.url), "utf8");
  const start = screen.indexOf(signature);
  const load = screen.slice(start, screen.indexOf("\n  }\n", start));

  it("puts the cached snapshot on screen once the wait passes the old eight seconds", () => {
    expect(start).toBeGreaterThan(0);
    const waiting = load.indexOf("const waiting = shownOnceRef.current");
    expect(waiting).toBeGreaterThan(0);
    const timer = load.slice(waiting, load.indexOf("}, STILL_TRYING_AFTER_MS);", waiting));
    expect(timer).toContain("const cached = await loadSnapshot();");
    expect(timer).toContain("if (settled || !cached || ");
    expect(timer).toContain("shownWhileWaiting = true;");
    expect(timer).toMatch(/await showCached\(cached, preferRouteId, load, "trying"/);
    // Set before the requests are asked, and cleared when they settle.
    expect(waiting).toBeLessThan(load.indexOf("getMe(requests.trace(\"me\")),"));
    expect(load).toMatch(/\]\)\.finally\(\(\) => \{\s*settled = true;\s*clearTimeout\(waiting\);\s*\}\);/);
  });

  /** Only the first: a load after a server switch holds a newer choice
   * than the cache, which would put another server on the tile. */
  it("does it only before the screen has shown anything", () => {
    expect(screen).toContain("const shownOnceRef = useRef(false);");
    expect(load).toContain("const waiting = shownOnceRef.current || background\n      ? undefined");
  });

  /** The screen may be in use by the time the load ends: a Connect
   * pressed on the cached credentials. What the load then learns changes
   * the banner and the data, and does not choose the credential again or
   * ask the platform again under a tunnel that may be up. */
  it("leaves what the screen is doing alone when the load ends after it", () => {
    const failed = load.slice(load.indexOf("if (!meResult.ok || !subsResult.ok || !usersResult.ok) {"));
    expect(failed).toMatch(
      /if \(shownWhileWaiting\) \{(\s*\/\/[^\n]*\n)+\s*setOfflineReason\(reason\);\s*offlineRetry\.start\(\);\s*return false;\s*\}/,
    );
    expect(load).toContain(
      "setProtocolUser((current) => usersResult.data.find((u) => u.id === current?.id) ?? current);",
    );
  });
});

describe("the Windows dashboard's load that answers after the snapshot went up", () => {
  const screen = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
  const start = screen.indexOf("  async function loadScreen(preferRouteId: string | undefined, retry: OfflineRetryTrigger | null): Promise<boolean> {");
  const load = screen.slice(start, screen.indexOf("\n  }\n", start));

  it("does not ask the service again, or capture baselines over a tunnel the screen may have brought up", () => {
    expect(load).toContain("const adopted = shownWhileWaiting ? null : await adoptServiceState(sub);");
    expect(load).toContain('if (adopted === "disconnected") await captureBaselinesWhileDown(usersResult.data);');
  });
});

describe("the phone's dashboard's load that answers after the snapshot went up", () => {
  const screen = readFileSync(new URL("../../../mobile/src/screens/Dashboard.tsx", import.meta.url), "utf8");
  const start = screen.indexOf("  async function loadScreen(");
  const load = screen.slice(start, screen.indexOf("\n  }\n", start));

  it("does not ask the platform again", () => {
    expect(load).toContain("if (!shownWhileWaiting) await adoptPlatform(sessionAtStart, usersResult.data, sub, ready);");
  });
});

/** A dashboard on its cached snapshot, on both clients, asks again and
 * says what it last heard (offline-retry.ts).
 *
 * The test VM, with every block lifted and the window in front: no
 * request for 150 seconds, "Can't reach Neoxify right now" throughout,
 * and still there above "You're protected" a minute after the claim and
 * the queued reports had been answered. Only leaving the screen and
 * coming back cleared it. The schedule itself is offline-retry.test.ts's,
 * and what counts as Neoxify answering is backend-answer.test.ts's; this
 * is the wiring, read from the source for the reason given above. */
describe.each(screens)("the %s dashboard on its snapshot", (_name, path, signature) => {
  const screen = readFileSync(new URL(path, import.meta.url), "utf8");
  const start = screen.indexOf(signature);
  const load = screen.slice(start, screen.indexOf("\n  }\n", start));
  const failed = load.slice(load.indexOf("if (!meResult.ok || !subsResult.ok || !usersResult.ok) {"));

  it("starts asking again wherever a load falls back to the snapshot, and stops where one is answered", () => {
    expect(screen).toContain("const offlineRetry = useOfflineRetry({");
    // Already on screen while the load waited, and put there now.
    expect(failed).toMatch(/setOfflineReason\(reason\);\s*offlineRetry\.start\(\);\s*return false;/);
    expect(failed).toMatch(/await showCached\(cached, preferRouteId, load, reason[^)]*\);\s*offlineRetry\.start\(\);\s*return false;/);
    // Answered: the banner goes, and nothing more is asked.
    expect(load).toMatch(/setOfflineSince\(null\);\s*offlineRetry\.stop\(\);/);
  });

  it("makes the background load without the loading screen, as one the snapshot is already in front of", () => {
    expect(load).toContain("const background = retry !== null;");
    expect(load).toMatch(/if \(!background\) \{\s*setLoading\(true\);\s*setError\(null\);\s*\}/);
    expect(load).toContain("let shownWhileWaiting = background;");
    // And leaves a server switch begun meanwhile to put its own answer up.
    expect(load).toContain("if (background && ");
    expect(screen).toMatch(/function loadInBackground\(why: OfflineRetryTrigger\): Promise<boolean> \{/);
  });

  it("never makes it beside a load of the screen's own", () => {
    expect(screen).toContain("busy: () => loadsInFlightRef.current > 0,");
    const own = screen.slice(screen.indexOf("  async function loadAll(preferRouteId?: string)"));
    expect(own).toMatch(/loadsInFlightRef\.current \+= 1;\s*try \{/);
    expect(own).toMatch(/\} finally \{\s*(ready\(\);\s*)?loadsInFlightRef\.current -= 1;/);
  });

  it("takes any answer from Neoxify as the last word on the banner, and asks again at once", () => {
    const heard = screen.slice(screen.indexOf("onBackendAnswer(() => {"));
    expect(heard).toMatch(
      /onBackendAnswer\(\(\) => \{\s*if \(offlineSinceRef\.current === null\) return;\s*setOfflineReason\("reached"\);\s*offlineRetry\.trigger\("answered"\);/,
    );
    expect(screen).toContain('if (connectionState === "connected") offlineRetry.trigger("tunnel");');
  });

  it("says no title over the saved copy once Neoxify has answered", () => {
    expect(screen).toMatch(/\{offlineText\(offlineReason, t\)\.title !== null \? \(/);
  });
});
