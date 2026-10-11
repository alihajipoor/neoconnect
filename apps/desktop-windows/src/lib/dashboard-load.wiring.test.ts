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
  ["Windows", "../screens/Dashboard.tsx", "  async function loadScreen(preferRouteId: string | undefined, retry: OfflineRetryTrigger | null): Promise<OfflineLoadOutcome> {"],
  ["phone", "../../../mobile/src/screens/Dashboard.tsx", "  async function loadScreen(preferRouteId: string | undefined, ready: () => void, retry: OfflineRetryTrigger | null = null): Promise<OfflineLoadOutcome> {"],
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
    expect(timer).toMatch(/await showCached\(\s*cached,\s*preferRouteId,\s*load,\s*reasonWhileWaiting\(/);
    // Set before the requests are asked, and cleared when they settle.
    expect(waiting).toBeLessThan(load.indexOf("getMe(requests.trace(\"me\")),"));
    expect(load).toMatch(/\]\)\.finally\(\(\) => \{\s*settled = true;\s*clearTimeout\(waiting\);\s*\}\);/);
  });

  /** "Still trying to reach Neoxify" says nothing has answered. The
   * account answering at two seconds, the credentials still out at eight,
   * and the banner said it anyway until the load ended. */
  it("says it is still trying only while nothing has answered since the load began", () => {
    const waiting = load.indexOf("const waiting = shownOnceRef.current");
    const timer = load.slice(waiting, load.indexOf("}, STILL_TRYING_AFTER_MS);", waiting));
    expect(timer).toContain("reasonWhileWaiting(answersHeardRef.current !== answersAtStart)");
    expect(timer).not.toContain('"trying"');
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
      /if \(shownWhileWaiting\) \{(\s*\/\/[^\n]*\n)+\s*setOfflineReason\(reason\);\s*offlineRetry\.start\(\);\s*return "unanswered";\s*\}/,
    );
    expect(load).toContain(
      "setProtocolUser((current) => usersResult.data.find((u) => u.id === current?.id) ?? current);",
    );
  });
});

describe("the Windows dashboard's load that answers after the snapshot went up", () => {
  const screen = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
  const start = screen.indexOf("  async function loadScreen(preferRouteId: string | undefined, retry: OfflineRetryTrigger | null): Promise<OfflineLoadOutcome> {");
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
    expect(failed).toMatch(/setOfflineReason\(reason\);\s*offlineRetry\.start\(\);\s*return "unanswered";/);
    expect(failed).toMatch(
      /await showCached\(cached, preferRouteId, load, reason[^)]*\);\s*offlineRetry\.start\(\);\s*return "unanswered";/,
    );
    // Answered: the banner goes, and nothing more is asked.
    expect(load).toMatch(/setOfflineSince\(null\);\s*offlineRetry\.stop\(\);/);
  });

  it("makes the background load without the loading screen, as one the snapshot is already in front of", () => {
    expect(load).toContain("const background = retry !== null;");
    expect(load).toMatch(/if \(!background\) \{\s*setLoading\(true\);\s*setError\(null\);\s*\}/);
    expect(load).toContain("let shownWhileWaiting = background;");
    // And leaves a server switch begun meanwhile to put its own answer up.
    expect(screen).toMatch(/function loadInBackground\(why: OfflineRetryTrigger\): Promise<OfflineLoadOutcome> \{/);
  });

  /** A background load in flight when a server switch's load begins, and
   * that load is answered; the background one then fails. It used to put
   * its failure on the banner and start the retrying again on a screen no
   * longer on its snapshot. */
  it("leaves a load of the screen's own begun meanwhile to say what is on screen, answered or not", () => {
    const sequence = path.includes("mobile") ? "loadRef" : "loadSeqRef";
    expect(load).toContain(`if (background && ${sequence}.current !== load) return "superseded";`);
    const superseded = failed.indexOf(`const superseded = background && ${sequence}.current !== load;`);
    expect(superseded).toBeGreaterThan(0);
    const out = failed.indexOf('if (superseded) return "superseded";');
    expect(out).toBeGreaterThan(superseded);
    // Before anything on the banner or the retrying.
    expect(out).toBeLessThan(failed.indexOf("setOfflineReason(reason);"));
    expect(out).toBeLessThan(failed.indexOf("offlineRetry.start();"));
  });

  it("never makes it beside a load of the screen's own", () => {
    expect(screen).not.toContain("loadsInFlightRef");
    const own = screen.slice(screen.indexOf("  async function loadAll(preferRouteId?: string)"));
    expect(own.slice(0, own.indexOf("\n  }\n"))).toContain("offlineRetry.ownLoad(");
    // Nor between a server switch being sent and its load beginning: the
    // switch's own answer is one of Neoxify's.
    const picking = screen.slice(screen.indexOf("  function pickingLocation(routeId: string | null) {"));
    expect(picking.slice(0, picking.indexOf("\n  }\n"))).toContain("if (routeId !== null) expectSwitchLoad();");
    expect(screen).toContain("switchLoadExpectedRef.current = offlineRetry.expectOwnLoad();");
    const listed = screen.slice(screen.indexOf("<LocationPicker"));
    const onFailed = listed.slice(listed.indexOf("onPickFailed={() => {"));
    expect(onFailed.slice(0, onFailed.indexOf("}}"))).toContain("switchLoadSettled();");
    const onSwitched = listed.slice(listed.indexOf("onSwitched={(routeId) => {"));
    expect(onSwitched.slice(0, onSwitched.indexOf("}}"))).toMatch(/void loadAll\(shown \?\? undefined\);(\s*\/\/[^\n]*\n)*\s*switchLoadSettled\(\);/);
  });

  /** Every answer Neoxify gives, the updater's check and the tunnel's
   * health check included (backend-answer-elsewhere.test.ts); what each
   * does to the banner and the asking again is offline-retry.test.ts's. */
  it("takes any answer from Neoxify as the last word on the banner, and asks again at once for all but the health check", () => {
    const heard = screen.slice(screen.indexOf("onBackendAnswer((answer) => {"));
    expect(heard).toMatch(
      /onBackendAnswer\(\(answer\) => \{\s*answersHeardRef\.current \+= 1;\s*if \(offlineSinceRef\.current === null\) return;\s*setOfflineReason\(\(current\) => reasonAfterAnswer\(current, answer\)\);\s*if \(answerAsksAgain\(answer\)\) offlineRetry\.trigger\("answered", \{ ifLoading: answer\.read \? "drop" : "keep" \}\);/,
    );
    expect(screen).not.toContain('setOfflineReason("reached")');
    expect(screen).toContain('if (connectionState === "connected") offlineRetry.trigger("tunnel");');
  });

  /** A load that began on the bare line failed after a tunnel's claim and
   * reports had been answered, and put "Can't reach Neoxify right now"
   * back up above "You're protected". */
  it("does not let a load that failed say Neoxify is out of reach when it answered after that load began", () => {
    expect(load).toContain("const answersAtStart = answersHeardRef.current;");
    expect(load.indexOf("const answersAtStart = answersHeardRef.current;")).toBeLessThan(
      load.indexOf('getMe(requests.trace("me")),'),
    );
    expect(failed).toMatch(
      /const reason = reasonAfterUnansweredLoad\(\s*failed && !failed\.ok \? reasonFor\(failed\) : "unreached",\s*answersHeardRef\.current !== answersAtStart,\s*\);/,
    );
  });

  it("says no title over the saved copy once Neoxify has answered", () => {
    expect(screen).toMatch(/\{offlineText\(offlineReason, t\)\.title !== null \? \(/);
  });
});
