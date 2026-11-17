import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The Linux 0.2 features as the shared interface carries them: updates
 * installed through the helper, Repair and Diagnostics in Linux's own
 * words, the reconnect hold's and Custom mode's sentences, and Built-in.
 * Windows' words and requests are checked unchanged beside each. */

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
type Listener = (event: { payload: { downloaded: number; total: number | null } }) => void;
let progress: Listener | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, fn: Listener) => {
    progress = fn;
    return () => {
      progress = null;
    };
  },
}));
const publicRequest = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("./api", () => ({ publicRequest: (path: string) => publicRequest(path) }));
const getAppLinks = vi.fn<() => Promise<unknown>>();
vi.mock("./customer", () => ({ getAppLinks: () => getAppLinks() }));
vi.mock("./social-auth", () => ({ socialStartBase: async () => "https://api.example.com/" }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: async () => undefined }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.2.0" }));

const { setDesktopPlatform } = await import("./desktop-platform");
const linuxUpdate = await import("./linux-update");
const notice = await import("./update-notice");
const repair = await import("./repair");
const { holdNotes } = await import("./reconnect-hold");
const { customModeProblemText } = await import("./custom-mode-problem");
const { unconfinedLine } = await import("./connection-evidence");
const { DICTIONARIES } = await import("./i18n");
const { I18nProvider } = await import("./i18n");
const { RepairNetwork, stepLabel } = await import("../components/RepairNetwork");
const { UpdateBanner } = await import("../components/UpdateBanner");
import type { UpdateState } from "./updates";
import type { InstallOutcome, WaitDeps } from "./linux-update";

const en = DICTIONARIES.en;
const t = (key: string) => (en as Record<string, string>)[key] ?? key;

const SIGNED = {
  version: "0.2.1",
  downloadPath: "/updates/installer/linux-deb",
  packages: { deb: "/updates/installer/linux-deb", rpm: "/updates/installer/linux-rpm" },
  signed: {
    deb: { url: "https://api.example.com/updates/download/linux-v0.2.1/Neoxify_0.2.1_amd64.deb", signature: "dW50cnVzdGVk" },
    rpm: { url: "https://api.example.com/updates/download/linux-v0.2.1/Neoxify-0.2.1-1.x86_64.rpm", signature: "c2lnbmVk" },
  },
};

/** The helper's commands, answered as a test says. */
function helper(answers: Record<string, (args?: unknown) => unknown>) {
  invoke.mockImplementation(async (cmd, args) => {
    const answer = answers[cmd];
    if (!answer) throw new Error(`no ${cmd}`);
    return answer(args);
  });
}

beforeEach(() => {
  invoke.mockReset();
  publicRequest.mockReset();
  getAppLinks.mockReset();
  getAppLinks.mockResolvedValue({ ok: false });
  linuxUpdate.resetLinuxUpdateForTests();
  notice.resetUpdateNoticeForTests();
  setDesktopPlatform("linux");
});

afterEach(() => {
  setDesktopPlatform("windows");
});

describe("the updates API's Linux answer", () => {
  it("reads each package's signed download, and drops one that is not https or has no signature", () => {
    const answer = notice.readNoticeAnswer({
      ok: true,
      data: { ...SIGNED, signed: { deb: SIGNED.signed.deb, rpm: { url: "http://example.com/x.rpm", signature: "s" } } },
    } as never);
    expect(answer.state).toBe("available");
    expect(linuxUpdate.signedFor(answer, "deb")).toEqual(SIGNED.signed.deb);
    expect(linuxUpdate.signedFor(answer, "rpm")).toBeNull();
    expect(linuxUpdate.signedFor(answer, null)).toBeNull();
    const noSignature = notice.readNoticeAnswer({ ok: true, data: { ...SIGNED, signed: { deb: { url: SIGNED.signed.deb.url, signature: " " } } } } as never);
    expect(linuxUpdate.signedFor(noSignature, "deb")).toBeNull();
  });

  it("an answer without signatures (0.1.0's) is still read as before", () => {
    expect(
      notice.readNoticeAnswer({ ok: true, data: { version: "0.2.0", downloadPath: "/updates/installer/linux-deb" } } as never),
    ).toEqual({ state: "available", version: "0.2.0", downloadPath: "/updates/installer/linux-deb" });
  });
});

describe("Linux self-update", () => {
  it("downloads the signed package for this install's kind, with progress, and says it is ready", async () => {
    publicRequest.mockResolvedValue({ ok: true, data: SIGNED });
    const downloads: unknown[] = [];
    helper({
      linux_update_support: () => ({ kind: "rpm", version: "0.2.0" }),
      linux_update_outcome: () => ({ state: "none" }),
      linux_update_download: (args) => {
        downloads.push(args);
        progress?.({ payload: { downloaded: 50, total: 200 } });
      },
    });
    const states: UpdateState[] = [];
    await linuxUpdate.checkAndStageLinux((s) => states.push(s));
    expect(publicRequest).toHaveBeenCalledWith("/updates/linux/x86_64/0.2.0");
    expect(downloads).toEqual([{ url: SIGNED.signed.rpm.url, signature: SIGNED.signed.rpm.signature, version: "0.2.1" }]);
    expect(states).toEqual([
      { status: "downloading", version: "0.2.1", percent: null },
      { status: "downloading", version: "0.2.1", percent: 25 },
      { status: "ready", version: "0.2.1" },
    ]);
    expect(linuxUpdate.stagedLinuxUpdate()).toBe("0.2.1");
  });

  it("falls back to the notice, linking this machine's package, when there is no signature for its kind", async () => {
    publicRequest.mockResolvedValue({ ok: true, data: { ...SIGNED, signed: { deb: SIGNED.signed.deb } } });
    helper({ linux_update_support: () => ({ kind: "rpm", version: "0.2.0" }), linux_update_outcome: () => ({ state: "none" }) });
    const states: UpdateState[] = [];
    await linuxUpdate.checkAndStageLinux((s) => states.push(s));
    expect(states).toEqual([{ status: "available", version: "0.2.1" }]);
    expect(invoke).not.toHaveBeenCalledWith("linux_update_download", expect.anything());
    expect(await notice.downloadPageUrl("en")).toBe("https://api.example.com/updates/installer/linux-rpm");
  });

  it("falls back to the notice and the website when the helper cannot say what this install is", async () => {
    publicRequest.mockResolvedValue({ ok: true, data: SIGNED });
    helper({ linux_update_support: () => ({ kind: null, version: "0.2.0", reason: "not a package install" }) });
    getAppLinks.mockResolvedValue({ ok: true, data: { websiteUrl: "https://www.example.com" } });
    const states: UpdateState[] = [];
    await linuxUpdate.checkAndStageLinux((s) => states.push(s));
    expect(states).toEqual([{ status: "available", version: "0.2.1" }]);
    expect(await notice.downloadPageUrl("fa")).toBe("https://www.example.com/fa/download/");
  });

  it("a download that fails leaves the notice, not a ready banner", async () => {
    publicRequest.mockResolvedValue({ ok: true, data: SIGNED });
    helper({
      linux_update_support: () => ({ kind: "deb", version: "0.2.0" }),
      linux_update_outcome: () => ({ state: "none" }),
      linux_update_download: () => {
        throw new Error("connection reset");
      },
    });
    const states: UpdateState[] = [];
    await linuxUpdate.checkAndStageLinux((s) => states.push(s));
    expect(states[states.length - 1]).toEqual({ status: "available", version: "0.2.1" });
    expect(linuxUpdate.stagedLinuxUpdate()).toBeNull();
  });

  it("does not try again a version whose install the helper says failed", async () => {
    publicRequest.mockResolvedValue({ ok: true, data: SIGNED });
    helper({
      linux_update_support: () => ({ kind: "deb", version: "0.2.0" }),
      linux_update_outcome: () => ({ state: "failed", version: "0.2.1", detail: "dpkg: dependency problems" }),
    });
    const states: UpdateState[] = [];
    await linuxUpdate.checkAndStageLinux((s) => states.push(s));
    expect(states).toEqual([{ status: "available", version: "0.2.1", installFailed: true }]);
  });

  it("says nothing when current or unanswered", async () => {
    const states: UpdateState[] = [];
    publicRequest.mockResolvedValue({ ok: true, data: undefined });
    await linuxUpdate.checkAndStageLinux((s) => states.push(s));
    publicRequest.mockResolvedValue({ ok: false });
    await linuxUpdate.checkAndStageLinux((s) => states.push(s));
    expect(states).toEqual([{ status: "none" }]);
  });
});

/** A clock and an outcome sequence for `waitForInstall`. */
function fakeWait(outcomes: (InstallOutcome | Error)[]): WaitDeps & { at: () => number } {
  let now = 0;
  let i = 0;
  return {
    at: () => now,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    outcome: async () => {
      const next = outcomes[Math.min(i, outcomes.length - 1)];
      i += 1;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

describe("waiting for the install", () => {
  it("waits through the helper being away while it is replaced, then sees the new version", async () => {
    const away = new Error("the background service is not running");
    const deps = fakeWait([{ state: "running", version: "0.2.1" }, ...Array(40).fill(away), { state: "installed", version: "0.2.1" }]);
    await expect(linuxUpdate.waitForInstall("0.2.1", deps)).resolves.toBeUndefined();
    expect(deps.at()).toBeLessThan(linuxUpdate.HELPER_AWAY_MS);
  });

  it("waits past an earlier install's record and a helper that has not recorded the start", async () => {
    const deps = fakeWait([{ state: "installed", version: "0.2.0" }, { state: "none" }, { state: "installed", version: "0.2.1" }]);
    await expect(linuxUpdate.waitForInstall("0.2.1", deps)).resolves.toBeUndefined();
  });

  it("gives up when the package manager says it failed", async () => {
    const deps = fakeWait([{ state: "running" }, { state: "failed", version: "0.2.1", detail: "dpkg: error" }]);
    await expect(linuxUpdate.waitForInstall("0.2.1", deps)).rejects.toThrow("dpkg: error");
  });

  it("gives up when the helper stays away for longer than two minutes", async () => {
    const deps = fakeWait([new Error("the background service is not running")]);
    await expect(linuxUpdate.waitForInstall("0.2.1", deps)).rejects.toThrow(/did not come back/);
    expect(deps.at()).toBeGreaterThan(linuxUpdate.HELPER_AWAY_MS);
  });

  it("gives up on an install that never finishes", async () => {
    const deps = fakeWait([{ state: "running", version: "0.2.1" }]);
    await expect(linuxUpdate.waitForInstall("0.2.1", deps)).rejects.toThrow(/too long/);
    expect(deps.at()).toBeGreaterThan(linuxUpdate.INSTALL_LONGEST_MS);
  });
});

describe("Restart on Linux", () => {
  async function stage() {
    publicRequest.mockResolvedValue({ ok: true, data: SIGNED });
    helper({
      linux_update_support: () => ({ kind: "deb", version: "0.2.0" }),
      linux_update_outcome: () => ({ state: "none" }),
      linux_update_download: () => undefined,
    });
    await linuxUpdate.checkAndStageLinux(() => undefined);
  }

  it("installs, waits for the new version and relaunches", async () => {
    await stage();
    const calls: string[] = [];
    helper({
      linux_update_install: () => calls.push("install"),
      linux_relaunch: () => calls.push("relaunch"),
    });
    const deps = fakeWait([{ state: "installed", version: "0.2.1" }]);
    expect(await linuxUpdate.applyLinuxUpdate(() => undefined, deps)).toBe(true);
    expect(calls).toEqual(["install", "relaunch"]);
  });

  it("a refused or failed install puts the notice back, saying it didn't install, and never relaunches", async () => {
    await stage();
    helper({
      linux_update_install: () => {
        throw new Error("a tunnel is up");
      },
    });
    const states: UpdateState[] = [];
    expect(await linuxUpdate.applyLinuxUpdate((s) => states.push(s), fakeWait([{ state: "none" }]))).toBe(false);
    expect(states).toEqual([{ status: "available", version: "0.2.1", installFailed: true }]);
    expect(invoke).not.toHaveBeenCalledWith("linux_relaunch", undefined);
    expect(linuxUpdate.stagedLinuxUpdate()).toBeNull();
  });
});

describe("the update banner", () => {
  const render = (state: UpdateState, extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(UpdateBanner, { state, onRestart: () => undefined, busy: false, blocked: false, onOpenDownload: () => undefined, ...extra }),
      ),
    );

  it("says an install is under way, and that one failed", () => {
    expect(render({ status: "ready", version: "0.2.1" }, { installing: true, busy: true })).toContain("Installing Neoxify 0.2.1...");
    expect(render({ status: "available", version: "0.2.1", installFailed: true })).toContain("Neoxify 0.2.1 didn&#x27;t install.");
    // Windows, which never passes either, is as it was.
    expect(render({ status: "ready", version: "0.9.65" })).toContain("Neoxify 0.9.65 is ready to install.");
  });
});

describe("Repair and Diagnostics on Linux", () => {
  it("labels every Linux step, in Linux's words where an id is shared with Windows", () => {
    for (const id of ["tunnel", "engines", "dns", "routes", "firewall", "links", "groups"]) {
      expect(stepLabel(id, t).known, id).toBe(true);
    }
    expect(stepLabel("firewall", t).label).toBe("Neoxify's firewall rules");
    expect(stepLabel("brandNew", t)).toEqual({ label: "brandNew", known: false });
    setDesktopPlatform("windows");
    expect(stepLabel("firewall", t).label).toBe("Custom mode firewall rule");
  });

  it("draws the Repair card without naming Windows", () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, null, createElement(RepairNetwork)));
    expect(html).toContain("Remove anything Neoxify has left behind on this computer.");
    expect(html).not.toContain("Windows");
    setDesktopPlatform("windows");
    expect(renderToStaticMarkup(createElement(I18nProvider, null, createElement(RepairNetwork)))).toContain(
      "Remove anything Neoxify has left behind on Windows.",
    );
  });

  it("hands over the helper's own repair command when it cannot be asked", async () => {
    invoke.mockRejectedValue(new Error("no such command"));
    expect(await repair.repairCommandLine()).toBe("sudo /usr/lib/neoxify/neoxify-helper repair");
    setDesktopPlatform("windows");
    expect(await repair.repairCommandLine()).toContain("neoconnect-service.exe");
  });

  it("asks the helper for its own diagnostics and writes them as plain lines", async () => {
    invoke.mockResolvedValue({
      helperVersion: "0.2.0",
      package: "deb",
      ourLinks: [{ name: "neoconnect0", present: true }],
      otherVpnsUp: [],
      ourRoutes: 2,
      ourRules: 1,
      firewallTable: true,
      splitTable: false,
      dnsMode: "systemd-resolved",
      dnsPointedAtUs: true,
      orphanedEngines: 0,
      owed: 0,
      controlGroups: true,
      programs: [{ name: "charon-cmd", present: false }],
      recentLog: ["swept nothing"],
    });
    const d = await repair.collectLinuxDiagnostics();
    expect(invoke).toHaveBeenCalledWith("vpn_linux_diagnostics", undefined);
    const text = repair.linuxDiagnosticsToText(d, "0.2.0", null, "webview: WebKitGTK 2.44.0");
    expect(text).toContain("helper: 0.2.0");
    expect(text).toContain("our interfaces: neoconnect0=yes");
    expect(text).toContain("other VPNs up: none");
    expect(text).toContain("DNS: systemd-resolved, pointed at the VPN: yes");
    expect(text).toContain("programs: charon-cmd=no");
    expect(text).toContain("webview: WebKitGTK 2.44.0");
    expect(text).toContain("  swept nothing");
    expect(text).not.toMatch(/WFP|NRPT|Windows/);
    // A field a helper did not send is said as that, never as "no" or 0.
    const partial = repair.linuxDiagnosticsToText({ helperVersion: "0.2.0" } as never, "0.2.0");
    expect(partial).toContain("firewall table: not reported");
    expect(partial).toContain("our routes: not reported");
  });

  it("Support reads the Linux snapshot on Linux and Windows' on Windows", () => {
    const support = readFileSync(new URL("../screens/Support.tsx", import.meta.url), "utf8");
    expect(support).toContain("linux ? collectLinuxDiagnostics() : collectDiagnostics()");
  });
});

describe("Linux's own sentences", () => {
  it("a refused hold names the firewall, not Windows", () => {
    const refused = { state: "notHeld", problem: "filtersRefused" } as never;
    expect(holdNotes(refused, { inGap: true, setting: true })).toEqual(["hold.filtersRefusedLinux"]);
    expect(t("hold.filtersRefusedLinux")).not.toContain("Windows");
    setDesktopPlatform("windows");
    expect(holdNotes(refused, { inGap: true, setting: true })).toEqual(["hold.filtersRefused"]);
  });

  it("Custom mode's refused sorting is said without Windows", () => {
    const problem = { code: "injectionRefused", sentence: "x" };
    expect(customModeProblemText(problem, t)).toBe(t("dash.customProblemInjectionRefusedLinux"));
    expect(customModeProblemText(problem, t)).not.toContain("Windows");
    setDesktopPlatform("windows");
    expect(customModeProblemText(problem, t)).toBe(t("dash.customProblemInjectionRefused"));
  });

  it("an unconfined Built-in session is a failed confinement on Linux, not Windows' standing exception", () => {
    expect(unconfinedLine({ protocol: "IKEV2" } as never)).toBe("dash.ipv4NotConfined");
    setDesktopPlatform("windows");
    expect(unconfinedLine({ protocol: "IKEV2" } as never)).toBe("dash.ipv4NotConfinedIkev2");
  });

  it("every new sentence is in Persian too, and none names a country", () => {
    const keys = [
      "update.installing",
      "update.installFailed",
      "dash.customProblemInjectionRefusedLinux",
      "err.engineMissingStrongswan",
      "repair.subtitleLinux",
      "repair.explainLinux",
      "repair.resultCleanLinux",
      "repair.resultUnverifiedLinux",
      "repair.resultProblemsLinux",
      "repair.noServiceHintLinux",
      "repair.step.links",
      "repair.step.groups",
      "repair.stepLinux.dns",
      "repair.stepLinux.routes",
      "repair.stepLinux.firewall",
      "hold.filtersRefusedLinux",
      "leak.notHeldLeadLinux",
      "leak.notHeldLinux",
    ] as const;
    for (const key of keys) {
      expect(DICTIONARIES.fa[key], key).toBeTruthy();
      expect(DICTIONARIES.fa[key], key).not.toBe(DICTIONARIES.en[key]);
      expect(`${DICTIONARIES.en[key]} ${DICTIONARIES.fa[key]}`, key).not.toMatch(/Iran|ایران|Windows|ویندوز/);
    }
  });
});

describe("Custom mode's card on Linux", () => {
  const card = readFileSync(new URL("../components/CustomModeCard.tsx", import.meta.url), "utf8");

  it("asks for no game catalogue or placements, and offers no game, exit or Windows ping note", () => {
    expect(card).toContain("const catalogue = supportsGameCatalogue();");
    expect(card).toMatch(/if \(!catalogue\) \{\s+return \(\) => \{/);
    expect(card).toMatch(/function refreshPlacements\(\) \{\s+\/\/[^\n]*\n\s+if \(!catalogue\) return;/);
    expect(card).toContain("{catalogue && games && games.length > 0 ? (");
    expect(card).toContain("{catalogue && pickingGame && games ? (");
    expect(card).toContain("{catalogue && settings.mode === \"onlySelected\" && settings.games.length > 0 && hasExitVocabulary(routes) ? (");
    expect(card).toMatch(/\{catalogue \? \(\s+<>\s+<p className="text-\[11px\] font-medium text-foreground">\s+\{t\("settings.customIcmpTitle"\)\}/);
  });

  it("browses for any file on Linux, and for .exe files on Windows", () => {
    expect(card).toContain('...(isLinux() ? {} : { filters: [{ name: t("settings.customFileFilter"), extensions: ["exe"] }] }),');
  });
});
