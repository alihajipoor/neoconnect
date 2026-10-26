import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
    expect(status).toContain("holdStore.observe(status.reconnectHold);");
    expect(status).toContain("holdStore.unanswered();");
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
    expect(announcer.slice(0, announcer.indexOf("\n}\n"))).toContain("setSaid((before) => announcedAtOnce(before, text));");
  });

  it("asks the switch confirmation what the hold covers, from the service's word", () => {
    const dash = source("../screens/Dashboard.tsx");
    expect(dash).toContain("covered: holdCovers(route?.protocol ?? null, customConfigured || splitTunnelActive),");
    expect(dash).toContain("description={t(switchBody(gap, { covered: switchAsk?.covered ?? true }))}");
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
});
