import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cleanFatalLine,
  describeLastRun,
  dropReason,
  fatalLine,
  pendingRunReason,
  preflightReason,
  REASON_MAX,
  resetDescribed,
  stopReasonName,
  type RunFiles,
} from "./run-diagnostics";

const NOW = 1_800_000_000;
const MiB = 1048576;

function heartbeat(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    t: NOW - 30,
    uptimeS: 13,
    footprint: Math.round(47.9 * MiB),
    footprintPeak: Math.round(48.2 * MiB),
    available: Math.round(1.1 * MiB),
    heap: 9_000_000,
    goroutines: 120,
    engine: "xray",
    core: "26.6.27",
    corePatched: true,
    ...over,
  });
}

const PANIC = [
  "panic: Net: Unknown address type",
  "",
  "goroutine 4123 [running]:",
  "github.com/xtls/xray-core/common/net.DestinationFromAddr(...)",
  "\t/Users/someone/go/pkg/mod/github.com/xtls/xray-core@v1.260327.0/common/net/destination.go:44 +0x1c8",
  "github.com/xtls/xray-core/proxy/tun.(*Handler).HandleConnection(0x140001a2000, {0x10a2b3c40, 0x14000abc000})",
  "\t/Users/someone/go/pkg/mod/github.com/xtls/xray-core@v1.260327.0/proxy/tun/handler.go:113 +0x5c",
].join("\n");

/** Anything that would identify a person, a network or a server. */
function assertClean(text: string) {
  expect(text).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  expect(text).not.toMatch(/[0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}/i);
  expect(text).not.toMatch(/@[\w-]+\./);
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  expect(text).not.toContain("someone");
  expect(text).not.toMatch(/example\.(com|net)/);
  expect(text).not.toMatch(/[A-Za-z0-9+/_=-]{20,}/);
}

beforeEach(() => resetDescribed());

describe("how the tunnel's last run ended, for a drop's report", () => {
  it("says a run that died ended without a stop reason, with its memory, engine and panic line", () => {
    const files: RunFiles = {
      lastEnd: null,
      run: JSON.stringify({ startedAt: NOW - 45 }),
      heartbeat: heartbeat(),
      fatalTail: PANIC,
    };
    const run = describeLastRun(files, NOW);
    expect(run.key).toBe(NOW - 45);
    expect(run.text).toBe(
      "run: ended without a stop reason, last heartbeat 30 s ago, up 13 s; mem peak 48.2 MiB, last 47.9 MiB, left 1.1 MiB; engine xray, core 26.6.27 patched; fatal: panic: Net: Unknown address type",
    );
  });

  it("names the stop reason of a run the system stopped", () => {
    const files: RunFiles = {
      lastEnd: null,
      run: JSON.stringify({ startedAt: NOW - 45, stopReason: 2, stoppedAt: NOW - 3 }),
      heartbeat: heartbeat({ t: NOW - 3 }),
      fatalTail: "",
    };
    expect(describeLastRun(files, NOW).text).toBe(
      "run: stopped (providerFailed), 3 s ago, up 13 s; mem peak 48.2 MiB, last 47.9 MiB, left 1.1 MiB; engine xray, core 26.6.27 patched",
    );
  });

  it("does not call a run ended while its heartbeat is still fresh", () => {
    const files: RunFiles = { lastEnd: null, run: JSON.stringify({ startedAt: NOW - 45 }), heartbeat: heartbeat({ t: NOW - 2 }), fatalTail: null };
    expect(describeLastRun(files, NOW).text).toMatch(/^run: no stop reason yet, extension may still be running/);
  });

  it("leaves out a heartbeat from before the run began", () => {
    const files: RunFiles = { lastEnd: null, run: JSON.stringify({ startedAt: NOW - 10 }), heartbeat: heartbeat({ t: NOW - 600 }), fatalTail: null };
    expect(describeLastRun(files, NOW).text).toBe("run: ended without a stop reason; no heartbeat");
  });

  it("falls back to the extension's own summary once the run has been summed up", () => {
    const lastEnd = {
      version: 1,
      recordedAt: NOW - 5,
      runStartedAt: NOW - 100,
      ended: "withoutStop",
      stopReason: null,
      stopReasonName: null,
      stoppedAt: null,
      lastHeartbeat: JSON.parse(heartbeat()),
      fatalSummary: "panic: runtime error: invalid memory address or nil pointer dereference",
      fatalTail: ["created by github.com/xtls/xray-core/proxy/tun.(*stack).Start in goroutine 1"],
    };
    // The current run is the one the summary was written by: already summed up.
    const files: RunFiles = { lastEnd: JSON.stringify(lastEnd), run: JSON.stringify({ startedAt: NOW - 100 }), heartbeat: null, fatalTail: null };
    expect(describeLastRun(files, NOW)).toEqual({
      key: NOW - 100,
      conclusive: true,
      text: "previous run: ended without a stop reason, up 13 s; mem peak 48.2 MiB, last 47.9 MiB, left 1.1 MiB; engine xray, core 26.6.27 patched; fatal: panic: runtime error: invalid memory address or nil pointer dereference",
    });
  });

  it("says when there is no record, and when the platform keeps none", () => {
    expect(describeLastRun(null, NOW)).toEqual({ key: null, conclusive: true, text: "run: no record on this platform" });
    expect(describeLastRun({ lastEnd: null, run: null, heartbeat: null, fatalTail: null }, NOW)).toEqual({ key: null, conclusive: true, text: "run: no record" });
    expect(describeLastRun({ lastEnd: "{not json", run: "[]", heartbeat: "x", fatalTail: null }, NOW)).toEqual({ key: null, conclusive: true, text: "run: no record" });
  });

  it("sends nothing it does not recognise: an odd engine or version is replaced", () => {
    const files: RunFiles = {
      lastEnd: null,
      run: JSON.stringify({ startedAt: NOW - 45 }),
      heartbeat: heartbeat({ engine: "203.0.113.9", core: "node.example.com" }),
      fatalTail: null,
    };
    const text = describeLastRun(files, NOW).text;
    expect(text).toContain("engine other, core ?");
    assertClean(text);
  });

  it("names every stop reason as Apple numbers them", () => {
    expect(stopReasonName(0)).toBe("none");
    expect(stopReasonName(11)).toBe("superceded");
    expect(stopReasonName(17)).toBe("internalError");
    expect(stopReasonName(-1)).toBe("startFailed");
    expect(stopReasonName(99)).toBe("unknown");
  });
});

describe("cleaning the fatal output", () => {
  it("keeps the panic line and source file names, and nothing that identifies anyone", () => {
    expect(fatalLine(PANIC)).toBe("panic: Net: Unknown address type");
    const lines = [
      "panic: dial tcp 203.0.113.9:443: connect: connection refused",
      "panic: lookup node-7.example.net on [2001:db8::1]:53: no such host",
      "fatal error: user 3f2504e0-4f89-11d3-9a0c-0305e82c3301 key AbCdEfGhIjKlMnOpQrStUvWxYz012345 someone@example.com",
      "\t/Users/someone/go/pkg/mod/github.com/xtls/xray-core@v1.260327.0/proxy/tun/handler.go:113 +0x5c",
      "panic: bad addr fe80::1%en0 at 0x14000abc000",
    ];
    const cleaned = lines.map((l) => cleanFatalLine(l));
    expect(cleaned[0]).toBe("panic: dial tcp <ip>: connect: connection refused");
    expect(cleaned[1]).toContain("<host>");
    expect(cleaned[2]).toBe("fatal error: user <id> key <id> <id>");
    expect(cleaned[3]).toBe("handler.go:113 +0x?");
    for (const line of cleaned) assertClean(line);
  });

  it("takes the last line when there is no panic line, and is cut short", () => {
    expect(fatalLine("one\n\ntwo 198.51.100.4\n")).toBe("two <ip>");
    expect(fatalLine("")).toBeNull();
    expect(fatalLine(null)).toBeNull();
    expect(cleanFatalLine("panic: " + "x ".repeat(400)).length).toBeLessThanOrEqual(160);
  });
});

describe("the reason texts sent", () => {
  it("a drop: prefixed, the state seen, the run, within the backend's 500 characters", () => {
    const files: RunFiles = {
      lastEnd: null,
      run: JSON.stringify({ startedAt: NOW - 45 }),
      heartbeat: heartbeat(),
      fatalTail: PANIC,
    };
    const reason = dropReason(files, "disconnected", NOW);
    expect(reason).toBe(
      "auto-reconnect drop seen; state disconnected; run: ended without a stop reason, last heartbeat 30 s ago, up 13 s; mem peak 48.2 MiB, last 47.9 MiB, left 1.1 MiB; engine xray, core 26.6.27 patched; fatal: panic: Net: Unknown address type",
    );
    expect(reason.length).toBeLessThanOrEqual(REASON_MAX);
    assertClean(reason);
    // The same run seen again -- the poll, then a screen mounting -- is not
    // described twice.
    expect(dropReason(files, "disconnected", NOW)).toBe("auto-reconnect drop seen; state disconnected; run: already reported");
    // A state that is not one of the words is not sent as itself.
    expect(dropReason(null, "203.0.113.9", NOW)).toBe("auto-reconnect drop seen; state other; run: no record on this platform");
    expect(dropReason(null, undefined, NOW)).toBe("auto-reconnect drop seen; state unread; run: no record on this platform");
  });

  it("never runs over 500 characters, whatever the files hold", () => {
    const files: RunFiles = {
      lastEnd: null,
      run: JSON.stringify({ startedAt: NOW - 45, stopReason: 2, stoppedAt: NOW }),
      heartbeat: heartbeat(),
      fatalTail: "panic: " + "word ".repeat(2000),
    };
    const reason = dropReason(files, "disconnecting", NOW);
    expect(reason.length).toBeLessThanOrEqual(REASON_MAX);
    expect(reason.startsWith("auto-reconnect drop seen;")).toBe(true);
  });

  it("a preflight: what it did, which check, and the state it saw", () => {
    expect(preflightReason({ branch: "ownStillStopping", outcome: "retry", state: "disconnecting" })).toBe(
      "auto-reconnect preflight will retry: our own tunnel was still not down at the end of the wait (ownStillStopping); state disconnecting",
    );
    expect(preflightReason({ branch: "chosenElsewhere", outcome: "stop", state: "disconnected" })).toBe(
      "auto-reconnect preflight stopped: another VPN configuration was chosen over ours (chosenElsewhere); state disconnected",
    );
    expect(preflightReason({ branch: "otherVpnUp", outcome: "stop", state: null })).toContain("state unread");
  });
});

/** Source assertions: neither binary is compiled here. */
describe("the wiring", () => {
  const dashboard = readFileSync(new URL("../screens/Dashboard.tsx", import.meta.url), "utf8");
  const swift = readFileSync(
    new URL("../../plugins/vpn/ios/Sources/NeoxifyVpnPlugin/NeoxifyVpnPlugin.swift", import.meta.url),
    "utf8",
  );
  const commands = readFileSync(new URL("../../plugins/vpn/src/commands.rs", import.meta.url), "utf8");
  const app = readFileSync(new URL("../../src-tauri/src/lib.rs", import.meta.url), "utf8");

  it("reports a drop as it is seen", () => {
    const start = dashboard.indexOf("function reportDrop() {");
    const drop = dashboard.slice(start, dashboard.indexOf("\n  }\n", start));
    expect(drop).toContain("void reportDropSeen(protocolUserRef.current?.protocol);");
  });

  it("status and tunnelGone read the state the same way, and name it the same way", () => {
    expect(swift).toContain("let up = TunnelPhase.up");
    expect(swift).toContain('"state": TunnelPhase.name(state),');
    expect(swift).toContain("let gone = all.allSatisfy { TunnelPhase.down($0) }");
    expect(swift).toContain('"seesOthers": false,');
    expect(swift).not.toContain("String(describing: state)");
  });

  it("the run files are read from the folder the extension writes, through a registered command", () => {
    expect(swift).toContain('.appendingPathComponent("diagnostics", isDirectory: true)');
    for (const name of ["tunnel-last-end.json", "tunnel-run.json", "engine-heartbeat.json", "engine-fatal.log"]) {
      expect(swift).toContain(`"${name}"`);
    }
    expect(commands).toContain('.run_mobile_plugin::<LastRunFiles>("lastRun", ())');
    expect(app).toContain("tauri_plugin_neoxify_vpn::vpn_last_run,");
  });

  it("the fatal output is read from its head, where the panic line is", () => {
    expect(swift).toContain('text("engine-fatal.log", tail: 4096, fromStart: true)');
  });

  it("a landing sends what a drop still owed, and a drop names its protocol", () => {
    expect(dashboard).toContain("reason: dropReason(files, status?.state, Date.now() / 1000, protocol),");
    expect(dashboard).toContain("void reportRunEndOwed();");
  });
});

describe("a crash or a memory kill seen while its heartbeat is fresh", () => {
  const crashed: RunFiles = {
    lastEnd: null,
    run: JSON.stringify({ startedAt: NOW - 20 }),
    heartbeat: heartbeat({ t: NOW - 3 }),
    fatalTail: PANIC,
  };

  it("is called ended without a stop reason when the system shows the tunnel down", () => {
    for (const state of ["disconnected", "invalid"]) {
      resetDescribed();
      const reason = dropReason(crashed, state, NOW);
      expect(reason).toContain("run: ended without a stop reason, last heartbeat 3 s ago");
      expect(reason).toContain("fatal: panic: Net: Unknown address type");
    }
  });

  it("is not counted as reported while it may still be running, and its summary is sent after the next start", () => {
    const first = dropReason(crashed, "disconnecting", NOW);
    expect(first).toContain("run: no stop reason yet, extension may still be running");
    // Seen again, still inconclusive: described again, not "already reported".
    expect(dropReason(crashed, "disconnecting", NOW)).toContain("may still be running");
    // The reconnect starts a new run, which sums the old one up.
    const summed: RunFiles = {
      lastEnd: JSON.stringify({
        version: 1,
        recordedAt: NOW + 10,
        runStartedAt: NOW - 20,
        ended: "withoutStop",
        stopReason: null,
        stopReasonName: null,
        stoppedAt: null,
        lastHeartbeat: JSON.parse(heartbeat({ t: NOW - 3 })),
        fatalSummary: "panic: Net: Unknown address type",
        fatalTail: [],
      }),
      run: JSON.stringify({ startedAt: NOW + 10 }),
      heartbeat: heartbeat({ t: NOW + 12 }),
      fatalTail: "",
    };
    const follow = pendingRunReason(summed);
    expect(follow).toBe(
      "auto-reconnect dropped run summed up; previous run: ended without a stop reason, up 13 s; mem peak 48.2 MiB, last 47.9 MiB, left 1.1 MiB; engine xray, core 26.6.27 patched; fatal: panic: Net: Unknown address type",
    );
    // Once.
    expect(pendingRunReason(summed)).toBeNull();
    // And a later drop of the new run does not send it again.
    expect(dropReason(summed, "connecting", NOW + 14)).toContain("run: no stop reason yet");
  });

  it("a later drop sends the summary of an earlier run no report has described", () => {
    const files: RunFiles = {
      lastEnd: JSON.stringify({ version: 1, runStartedAt: NOW - 100, ended: "withoutStop", lastHeartbeat: null, fatalSummary: "", fatalTail: [] }),
      run: JSON.stringify({ startedAt: NOW - 20 }),
      heartbeat: heartbeat({ t: NOW - 2 }),
      fatalTail: null,
    };
    expect(dropReason(files, "connecting", NOW)).toContain("previous run: ended without a stop reason");
    expect(dropReason(files, "connecting", NOW)).toContain("run: no stop reason yet");
  });

  it("nothing is owed when every drop was conclusive", () => {
    dropReason(crashed, "disconnected", NOW);
    expect(pendingRunReason(crashed)).toBeNull();
  });

  it("an IKEv2 drop carries no run clause: the extension did not carry it", () => {
    expect(dropReason(crashed, "disconnected", NOW, "IKEV2")).toBe(
      "auto-reconnect drop seen; state disconnected; run: IKEv2, the system's own client",
    );
    // And the crashed run is still sent with the next drop that is ours.
    expect(dropReason(crashed, "disconnected", NOW)).toContain("fatal: panic");
  });
});

describe("cleaning lines that touch a word character", () => {
  it.each([
    ["dial dest_203.0.113.7:443 failed", "203.0.113"],
    ["x203.0.113.7 refused", "203.0.113"],
    ["at 203.0.113.7abc", "203.0.113"],
    ["proxy https://user:pass@node.example.com/x", "user"],
    ["proxy https://user:pass@node.example.com/x", "pass"],
    ["short id 6ba85179e30d4fc2 rejected", "6ba85179e30d4fc2"],
    ["sid=6ba85179e30d4fc2", "6ba85179e30d4fc2"],
    ["password Zx9kQ2mP7vL4w rejected", "Zx9kQ2mP7vL4w"],
    ["lookup dest_node.example.com failed", "example"],
    ["route via dest_2001:db8::1", "2001"],
  ])("%s", (line, secret) => {
    const cleaned = cleanFatalLine(line);
    expect(cleaned).not.toContain(secret);
    assertClean(cleaned);
  });

  it("keeps the words and the file names that make a line useful", () => {
    expect(cleanFatalLine("panic: Net: Unknown address type")).toBe("panic: Net: Unknown address type");
    expect(cleanFatalLine("\thandler.go:113 +0x5c")).toBe("handler.go:113 +0x?");
    expect(cleanFatalLine("fatal error: concurrent map writes")).toBe("fatal error: concurrent map writes");
  });

  it("uses no lookbehind, which iOS 15's WebKit cannot load", () => {
    const source = readFileSync(new URL("./run-diagnostics.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\(\?<[=!]/);
  });
});
