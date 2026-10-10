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
  ["Windows", "../screens/Dashboard.tsx", "  async function loadAll(preferRouteId?: string) {"],
  ["phone", "../../../mobile/src/screens/Dashboard.tsx", "  async function loadScreen(preferRouteId: string | undefined, ready: () => void) {"],
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
    expect(load).toContain("const waiting = shownOnceRef.current\n      ? undefined");
  });

  /** The screen may be in use by the time the load ends: a Connect
   * pressed on the cached credentials. What the load then learns changes
   * the banner and the data, and does not choose the credential again or
   * ask the platform again under a tunnel that may be up. */
  it("leaves what the screen is doing alone when the load ends after it", () => {
    const failed = load.slice(load.indexOf("if (!meResult.ok || !subsResult.ok || !usersResult.ok) {"));
    expect(failed).toMatch(/if \(shownWhileWaiting\) \{\s*\/\/[^\n]*\n\s*setOfflineReason\(reason\);\s*return;\s*\}/);
    expect(load).toContain(
      "setProtocolUser((current) => usersResult.data.find((u) => u.id === current?.id) ?? current);",
    );
  });
});

describe("the Windows dashboard's load that answers after the snapshot went up", () => {
  const screen = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
  const start = screen.indexOf("  async function loadAll(preferRouteId?: string) {");
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
