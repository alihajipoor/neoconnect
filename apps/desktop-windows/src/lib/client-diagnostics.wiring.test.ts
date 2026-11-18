import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DICTIONARIES } from "./i18n";

/** The fuller reports, wired where they have to be (docs/client-diagnostics.md):
 * each ladder times its rungs and sends the times, files its error kind,
 * notes the tunnel it landed on, and starts the service check only once
 * its success report is out; each screen ends the session it tracks. And
 * every new string exists in both languages. */

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const LOOP = "for (let index = 0; index < candidates.length || queueSlowFallback(); index += 1) {";

const windows = source("../screens/Dashboard.tsx");
const windowsPass = windows.slice(windows.indexOf("async function runLadder("));
const phone = source("../../../mobile/src/screens/Dashboard.tsx");
const phonePass = phone.slice(phone.indexOf("async function walkLadder("));

for (const [name, pass] of [
  ["the Windows ladder", windowsPass],
  ["the phone's ladder", phonePass],
] as const) {
  describe(name, () => {
    it("times each rung from its start, and keeps pushing its lines where it did", () => {
      expect(pass).toContain("const rungClock = timedRungs();");
      expect(pass).toContain("const attempts: string[] = rungClock.lines;");
      const loop = pass.indexOf(LOOP);
      expect(loop).toBeGreaterThan(-1);
      expect(pass.slice(loop, loop + 200)).toContain("rungClock.start();");
    });

    it("sends the times with the success and the failure", () => {
      const landed = pass.indexOf("const rungMs = rungClock.landed();");
      const sample = pass.indexOf("void sampleDownload(sampleBase)", landed);
      expect(landed).toBeGreaterThan(-1);
      // Taken as the rung lands, not after the sample.
      expect(sample).toBeGreaterThan(landed);
      expect(pass.slice(sample, sample + 2000)).toContain("rungMs,");
      expect(pass).toContain("rungsFrom(attempts, dials, rungClock.ms)");
      expect(pass).toContain("details: { errorKind: lastError.kind }");
    });

    it("notes the tunnel it landed on", () => {
      expect(pass).toContain("noteTunnel({");
      expect(pass).toContain("tunnelResolvers(candidate.protocol, candidate.credentials,");
    });

    it("starts the service check only after its success report, on a proven tunnel still up", () => {
      const check = pass.indexOf("void runScheduledServiceCheck({");
      expect(check).toBeGreaterThan(-1);
      const before = pass.slice(0, check);
      expect(before.lastIndexOf(").then(() => {")).toBeGreaterThan(before.lastIndexOf('outcome: "SUCCESS"'));
      expect(pass.slice(check, check + 500)).toContain("stillUp: () =>");
    });
  });
}

describe("the session's end", () => {
  it("is said by each screen: a disconnect press, and a lost tunnel", () => {
    for (const screen of [windows, phone]) {
      expect(screen).toContain('sessionTrackerRef.current.ended("disconnected");');
      expect(screen).toContain('sessionTrackerRef.current.ended("lost");');
    }
  });

  it("is never taken from the local session log, which stays on the device", () => {
    for (const file of ["./session-report.ts", "./report-details.ts", "./service-check.ts", "./diagnostics-bundle.ts", "./attempts.ts"]) {
      expect(source(file)).not.toMatch(/from "\.\/session-log"/);
    }
    expect(source("../screens/Support.tsx")).not.toContain("session-log");
  });
});

describe("Windows' automatic check", () => {
  it("never runs in Custom or gaming mode", () => {
    expect(windowsPass).toContain('fullTunnel: appModeRef.current !== "gaming" && !customMode,');
  });
});

describe("the new strings", () => {
  const keys = Object.keys(DICTIONARIES.en).filter((k) => k.startsWith("check.") || k.startsWith("send."));

  it("exist, in both languages", () => {
    expect(keys.length).toBeGreaterThanOrEqual(28);
    for (const key of keys) {
      expect(DICTIONARIES.en[key as keyof typeof DICTIONARIES.en].trim(), key).not.toBe("");
      expect(DICTIONARIES.fa[key as keyof typeof DICTIONARIES.fa]?.trim(), key).toBeTruthy();
      expect(DICTIONARIES.fa[key as keyof typeof DICTIONARIES.fa], key).not.toBe(DICTIONARIES.en[key as keyof typeof DICTIONARIES.en]);
    }
  });

  it("keep their placeholders in Persian", () => {
    for (const key of keys) {
      const holes = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
      expect(holes(DICTIONARIES.fa[key as keyof typeof DICTIONARIES.fa]), key).toEqual(
        holes(DICTIONARIES.en[key as keyof typeof DICTIONARIES.en]),
      );
    }
  });

  it("name no country, protocol or port", () => {
    for (const key of keys) {
      for (const text of [DICTIONARIES.en[key as keyof typeof DICTIONARIES.en], DICTIONARIES.fa[key as keyof typeof DICTIONARIES.fa]]) {
        expect(text).not.toMatch(/Iran|ایران|WireGuard|Xray|IKEv2|OpenVPN|\bports?\b|پورت/i);
      }
    }
  });

  it("include the disclosure's new meaning, and leave the log's promise as it was", () => {
    expect(DICTIONARIES.en["disclosure.dataDiagnostics"]).toContain("About once a day the app also tests");
    expect(DICTIONARIES.en["disclosure.dataDiagnostics"]).toContain("It never records the sites you visit.");
    expect(DICTIONARIES.fa["disclosure.dataDiagnostics"]).toContain("روزی یک بار");
    expect(DICTIONARIES.en["set.historyHint"]).toContain("The log stays on this device for 7 days and isn't sent anywhere.");
    expect(DICTIONARIES.en["disclosure.dataNotSold"]).toContain("In Custom mode, the list of apps you choose never leaves this device.");
  });
});
