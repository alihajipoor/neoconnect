import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ATTEMPT_MAX_MS, BLOCKED_WAIT_MAX_MS } from "./auto-reconnect";
import { DICTIONARIES } from "./i18n";
import { RECONNECT_HOLD_OFFERED, RECONNECT_HOLD_PROVEN } from "./reconnect-hold";

/** "Block the internet while reconnecting" is not offered until a capture
 * has proved it (`RECONNECT_HOLD_PROVEN`). These hold the gate where it is
 * read: a release build draws no switch, tells every connect the setting
 * is off, and says nothing of a hold -- whatever a test build saved. */

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const repo = (path: string) => source(`../../../../${path}`);

describe("the reconnect hold's gate", () => {
  it("is shut in a build that sets nothing, as a release is built", () => {
    expect(RECONNECT_HOLD_PROVEN).toBe(false);
    expect(RECONNECT_HOLD_OFFERED).toBe(false);
  });

  it("draws the switch only in a build that offers it", () => {
    const app = source("../App.tsx");
    const binding = app.slice(app.indexOf("const WINDOWS_DEVICE: DeviceSettings = {"));
    const body = binding.slice(0, binding.indexOf("\n};\n"));
    expect(body).toMatch(/\.\.\.\(RECONNECT_HOLD_OFFERED\s+\?\s+\{ reconnectHold: /);
    // Nowhere else is it bound.
    expect(app.split("reconnectHold:").length).toBe(2);
  });

  it("is never opened by the release workflow, only by the VM's test installer when asked", () => {
    expect(repo(".github/workflows/release-desktop-windows.yml")).not.toContain("VITE_RECONNECT_HOLD");
    expect(repo(".github/workflows/ci.yml")).not.toContain("VITE_RECONNECT_HOLD");
    const test = repo(".github/workflows/build-test-installer.yml");
    expect(test).toMatch(/reconnect_hold:\s+description:[^\n]*\n\s+required: false\n\s+default: false\n\s+type: boolean/);
    expect(test).toContain("VITE_RECONNECT_HOLD: ${{ inputs.reconnect_hold && '1' || '' }}");
  });

  it("compiles the service's VM test switches into the test installer that offers it, and into nothing else", () => {
    // reconnect_hold::TestSwitches: filters refused, a WireGuard server
    // unnamed -- what gate 1b needs forced. Read from a file the guest
    // writes, and only in a build that set this at compile time.
    for (const workflow of [".github/workflows/release-desktop-windows.yml", ".github/workflows/ci.yml"]) {
      expect(repo(workflow)).not.toContain("NEOXIFY_RECONNECT_HOLD_TEST");
    }
    const test = repo(".github/workflows/build-test-installer.yml");
    expect(test.match(/NEOXIFY_RECONNECT_HOLD_TEST:/g)).toHaveLength(1);
    expect(test).toContain("NEOXIFY_RECONNECT_HOLD_TEST: ${{ inputs.reconnect_hold && '1' || '' }}");
    const hold = repo("apps/desktop-windows/service/src/engines/reconnect_hold.rs");
    expect(hold).toContain('match option_env!("NEOXIFY_RECONNECT_HOLD_TEST") {');
    expect(hold).toContain("Some(value) => value.len() == 1 && value.as_bytes()[0] == b'1',");
  });

  it("hears the service's word from the very read that finds the drop", () => {
    // The liveness poll found drops and dropped the read: the screen kept
    // the "armed" from before and said traffic was going out without
    // Neoxify while the service held it.
    const dash = source("../screens/Dashboard.tsx");
    const look = dash.slice(dash.indexOf("const status = await serviceStatus().catch(() => null);"));
    const noted = look.indexOf("if (status !== null) noteStatus(status);");
    const dropped = look.indexOf("publishDrop(generation);");
    expect(noted).toBeGreaterThan(-1);
    expect(dropped).toBeGreaterThan(noted);
  });

  it("says where traffic goes in the gap from one source, on screen and in notifications", () => {
    const dash = source("../screens/Dashboard.tsx");
    expect(dash).toContain("const gap = gapTraffic(hold, holdWanted(prefs.blockWhileReconnecting));");
    expect(dash).toContain("      gap: gapSaid,\n");
    expect(dash).toContain("const gapSaid = gapWord(gap, holdWordLate);");
    // Given its grace, by the one clock both read.
    expect(dash).toContain("const holdWordAwaited = (inHoldGap || waitingForNetwork) && gap === \"unconfirmed\";");
    expect(dash).toContain("const id = setTimeout(() => setHoldWordLate(true), HOLD_WORD_GRACE_MS);");
    expect(dash).toMatch(/holdHint\(hold, \{[^}]*wordLate: holdWordLate \}\)/);
    // Over everything else under the state, from the one table (`hintKey`),
    // in every phase the scene names (`holdScene`).
    expect(dash).toContain("const hintSaid = hintKey(heldHint, {");
    expect(dash).toContain("const heldHint = holdHint(hold, { ...holdScene, setting: holdSetting, wordLate: holdWordLate });");
    expect(dash).toContain("const heldNotes = holdNotes(hold, { inGap: holdSpoken(hold, holdScene), setting: holdSetting });");
    // No sentence about the hold picked by hand, and no release on a
    // single status read.
    expect(dash).not.toMatch(/t\("hold\./);
    expect(dash).not.toContain("shouldRelease");
    expect(dash).toContain("statusReleaseRef.current.see({");
    const notify = source("./connection-notify.ts");
    expect(notify).toContain("readonly gap: GapWord;");
    expect(notify).not.toMatch(/readonly holding|input\.holding/);
  });

  it("hears the service on every status read, says it is checking when none is answered, and drops the held words on a release's reply", () => {
    const dash = source("../screens/Dashboard.tsx");
    const status = dash.slice(dash.indexOf("function serviceStatus(): Promise<VpnStatus> {"), dash.indexOf("function serviceDisconnect(): Promise<void> {"));
    // Taken with when the read was sent: never put back over the app's own
    // word on the hold that came after it (`observeRead`).
    expect(status).toContain("const mark = holdStore.decisionMark();");
    expect(status).toContain("holdStore.observeRead(mark, status.reconnectHold);");
    expect(status).toContain("holdStore.unanswered(serviceGone(err));");
    expect(dash).not.toContain("holdStore.observe(status.reconnectHold);");
    const disconnect = dash.slice(dash.indexOf("function serviceDisconnect(): Promise<void> {"));
    expect(disconnect.slice(0, disconnect.indexOf("\n}\n"))).toContain("holdStore.released();");
    const hold = source("./reconnect-hold.ts");
    expect(hold).toContain("released: () => holdStore.released(),");
  });

  it("treats the mid-session failover as a reconnect while the service holds for it", () => {
    const dash = source("../screens/Dashboard.tsx");
    expect(dash).toContain("const failover = options.automatic === true && options.reconnect === undefined;");
    expect(dash).toContain("const inHoldGap = reconnectRunning || gapDropped || failoverRunning;");
    expect(dash).toContain("const failoverSaid = failoverRunning && holdWanted(prefs.blockWhileReconnecting);");
    expect(dash).toContain("const notifyReconnecting = reconnectRunning || failoverSaid;");
    expect(dash).toContain("      reconnecting: notifyReconnecting,\n      failover: failoverSaid && !reconnectRunning,\n      gap: gapSaid,");
    expect(dash).toMatch(/shownTone\(orbTone\(orbState, cautionShown\), \{\s+reconnecting: notifyReconnecting,/);
    // Started and ended by the pass itself, and only by the one that set it.
    expect(dash).toContain("if (failover && failoverPassRef.current === generation) {");
  });

  it("draws the held words in no failure's colour, over a degraded tunnel too, and lets the screen reader drop stale words at once", () => {
    const dash = source("../screens/Dashboard.tsx");
    // Between two failed attempts the held sentence stands, not as an error.
    expect(dash).toContain("const hintFailed = connectionError !== null && hintSaid === connectionError.messageKey;");
    expect(dash).toContain("<Hint tone={hintTone(calmTone, { failed: hintFailed })} reserve={hintReserve}>");
    expect(dash).not.toContain("failed: connectionError !== null })} reserve=");
    expect(dash).toContain('    degraded: connectionState === "degraded",\n  };');
    const hero = source("../components/main/Hero.tsx");
    const announcer = hero.slice(hero.indexOf("export function StateAnnouncer"));
    const body = announcer.slice(0, announcer.indexOf("\n}\n"));
    expect(body).toContain("setSaid((before) => announcedAtOnce(before, text));");
    // And says nothing again for a blip back to what it said last.
    expect(body).toContain("const next = announcedOnSettle(spoken.current, text);");
    expect(body).toContain("if (next === null) return;");
  });

  it("follows the failover's held loss to its end, says a hold let go of in a pass that keeps it, and lets go at a landing only as it allows", () => {
    const dash = source("../screens/Dashboard.tsx");
    // A failover that gave up after its loss was said is owed "dropped".
    expect(dash).toContain("const gapDropped = tunnelDropped || failoverLost || reconnectLost(reconnect, sessionGeneration());");
    expect(dash).toContain("      letGo: holdLetGo,\n");
    expect(dash).toContain("      dropped: failoverLost,\n");
    expect(dash).toContain("const holdLetGo = hold?.state === \"notHeld\";");
    expect(dash).toContain("notifyMemory.current().lostSaid\n        ) {\n          setFailoverLost(true);");
    // The scene knows a pass keeps the hold, from the pass itself.
    expect(dash).toContain("    holdKept: holdPassRunning,\n");
    expect(dash).toContain("if (holdThrough) {\n      holdPassRef.current = generation;\n      setHoldPassRunning(true);");
    // A landing lets go as `landingReleases` says, nowhere unconditionally.
    expect(dash).toContain("if (holdWanted(appPrefs.current().blockWhileReconnecting)) void releaseOnLanding(verdict);");
    expect(dash).toContain("if (landingReleases(verdict, status && { hold: holdStore.current(), status })) await holdService.release();");
  });

  it("asks the switch confirmation what the hold covers, from the service's word", () => {
    const dash = source("../screens/Dashboard.tsx");
    expect(dash).toContain("covered: holdCovers(route?.protocol ?? null, customConfigured || splitTunnelActive),");
    expect(dash).toContain("description={t(switchBody(gap, { covered: switchAsk?.covered ?? true, inGap: inHoldGap }))}");
    expect(dash).not.toContain('description={t("sw.body")}');
  });

  it("is read through holdWanted wherever the preference decides what is held or said", () => {
    for (const path of ["../App.tsx", "../screens/Dashboard.tsx", "../screens/Settings.tsx"]) {
      const lines = source(path)
        .split("\n")
        .filter((line) => /\.blockWhileReconnecting\b/.test(line));
      expect(lines.length, path).toBeGreaterThan(0);
      for (const line of lines) {
        // The switch itself, drawn only where it is offered, and an
        // effect's dependency list read the preference as saved;
        // everything else goes through the gate.
        if (line.includes("checked={prefs.value.blockWhileReconnecting}")) continue;
        if (line.includes("}, [inHoldGap, prefs.blockWhileReconnecting]);")) continue;
        const reads = line.split(".blockWhileReconnecting").length - 1;
        const gated = line.match(/holdWanted\((?:appPrefs\.current\(\)|prefs|prefs\.value)\.blockWhileReconnecting\)/g)?.length ?? 0;
        expect(gated, `${path}: ${line.trim()}`).toBe(reads);
      }
    }
  });

  // The VM, round 3 (F1, F2): the let-go of a connect the hold does not
  // cover was heard only after that connect had dialled, and one inside a
  // covered connect only at the next poll.
  // Round 4: and only the service's own read says the let-go of a connect it
  // does not cover, read while that connect dials as for one it covers.
  it("drops 'blocked' before a connect the hold does not cover is sent, and reads the word while any connect over a hold dials", () => {
    const dash = source("../screens/Dashboard.tsx");
    const letting = dash.indexOf("if (holdSetting && !holdCovers(candidate.protocol, customMode)) holdStore.lettingGo();");
    const sent = dash.indexOf('const dial = invoke("vpn_connect", {');
    expect(letting).toBeGreaterThan(-1);
    expect(sent).toBeGreaterThan(letting);
    const after = dash.slice(sent);
    expect(after.slice(0, after.indexOf("showNetworkWait(false);"))).toContain("await dialledUnderHold(dial);");
    const dialled = dash.slice(dash.indexOf("function dialledUnderHold<T>("));
    const body = dialled.slice(0, dialled.indexOf("\n}\n"));
    expect(body).toContain("const state = holdStore.current()?.state;");
    expect(body).toContain(
      'return holdStore.dialling(state === "holding" || state === "lettingGo" ? readWhileDialling(dial, { read: serviceStatus }) : dial);',
    );
    // Nowhere does the app say "not held" on its own.
    expect(source("./reconnect-hold.ts")).not.toMatch(/set\(\{ state: "notHeld"/);
    // The one connect the screen sends.
    expect(dash.split('invoke("vpn_connect"').length).toBe(2);
    // A service not there at all is said as gone wherever the gap's calls meet it.
    expect(dash).toContain("if (serviceGone(err)) holdStore.unanswered(true);\n          const classified = classifyConnectionError(err);");
    const disconnect = dash.slice(dash.indexOf("function serviceDisconnect(): Promise<void> {"));
    expect(disconnect.slice(0, disconnect.indexOf("\n}\n"))).toContain("if (serviceGone(err)) holdStore.unanswered(true);");
  });

  // F3: the teardown that keeps the hold says it on its own answer.
  it("says a reconnect's teardown over an armed tunnel held on its answer, before the read it sends", () => {
    const hold = source("./reconnect-hold.ts");
    const keeping = hold.slice(hold.indexOf("async disconnectKeepingHold(): Promise<void> {"));
    const body = keeping.slice(0, keeping.indexOf("\n  },\n"));
    const held = body.indexOf("holdStore.heldNow();");
    expect(held).toBeGreaterThan(body.indexOf('invoke<void>("vpn_disconnect_for_reconnect")'));
    expect(body.indexOf('invoke<{ reconnectHold?: unknown }>("vpn_status")')).toBeGreaterThan(held);
  });

  // The VM, round 3 (F7): the app ended its wait at 30 minutes and let go, so
  // the service's 40-minute let-go never ran and was never seen to. Round 4:
  // the app's half hour bounds one wait, not an episode -- each wait starts
  // its own clock -- so the 40 minutes can be reached while the app works,
  // and nothing claims otherwise.
  it("keeps the service's own let-go past one wait and an attempt, claims no more for it, and reaches it on the VM", () => {
    const hold = repo("apps/desktop-windows/service/src/engines/reconnect_hold.rs");
    const longest = hold.match(/pub const HOLD_LONGEST: Duration = Duration::from_secs\((\d+) \* 60\);/);
    expect(longest).not.toBeNull();
    // One wait and one attempt never reach it; an episode of several may.
    expect(Number(longest![1]) * 60_000).toBeGreaterThan(BLOCKED_WAIT_MAX_MS + ATTEMPT_MAX_MS);
    const reconnect = source("./auto-reconnect.ts");
    for (const [file, text] of [
      ["reconnect_hold.rs", hold],
      ["auto-reconnect.ts", reconnect],
    ] as const) {
      expect(text, file).not.toMatch(/The app owns the timeout|the one owner of\s+(?:\/\/\/\s+|\*\s+)?how long|it is never reached/);
      expect(text, file).toMatch(/bounds one wait,\s+(?:\/\/\/\s+|\*\s+)?not the episode/);
    }
    // When it fires it is said as what it is, in both languages.
    for (const language of ["en", "fa"] as const) expect(DICTIONARIES[language]["hold.timedOut"], language).toBeTruthy();
    // Every status poll goes by what the ops say, which a test build reads
    // from the guest's switch file.
    expect(hold).toContain("if !self.expire_if_due(tunnel_up, self.ops.longest()) {");
    expect(hold).toContain('if let Some(secs) = line.strip_prefix("hold-longest-secs=") {');
    expect(hold).toContain("TestSwitches::read(&self.data_dir).longest_secs.map_or(HOLD_LONGEST, Duration::from_secs)");
  });
});
