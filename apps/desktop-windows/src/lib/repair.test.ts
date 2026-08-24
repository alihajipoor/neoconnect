import { describe, expect, it } from "vitest";
import {
  anythingFixed,
  diagnosticsToText,
  unresolvedSteps,
  type Diagnostics,
  type RepairReport,
  type RepairStep,
} from "./repair";

function step(id: string, outcome: RepairStep["outcome"], detail?: string): RepairStep {
  return { id, label: id, outcome, detail };
}

const EMPTY: Diagnostics = {
  serviceVersion: "0.1.0",
  ourAdapters: [
    { name: "neoconnect0", present: false },
    { name: "Neoxify-OpenVPN", present: false },
  ],
  otherVpnsUp: [],
  ourRoutes: [],
  nrptRules: 0,
  splitTunnelFirewallRule: false,
  orphanedEngines: [],
  wireguardTunnelService: false,
  rasEntry: false,
  wfpFilters: 0,
  cleanupLogTail: [],
};

describe("what counts as a repaired machine", () => {
  /** The product rule, on the app side of the wire.
   *
   * A step that could not be checked is not a step that found the
   * machine clean. Getting this backwards would show a green summary
   * over a machine whose DNS rule nobody managed to look at -- which is
   * the same claim-without-evidence this whole client is built to
   * refuse.
   */
  it("treats a step that could not be checked as unresolved", () => {
    const report: RepairReport = {
      steps: [step("dns", "alreadyClean"), step("wfp", "unknown", "the filtering platform would not answer")],
    };
    expect(unresolvedSteps(report).map((s) => s.id)).toEqual(["wfp"]);
  });

  it("treats a step that could not be fixed as unresolved", () => {
    const report: RepairReport = {
      steps: [step("dns", "alreadyClean"), step("routes", "failed", "still present: 2 on neoconnect0")],
    };
    expect(unresolvedSteps(report).map((s) => s.id)).toEqual(["routes"]);
  });

  // The control. Without it every assertion above would pass on an
  // implementation that called everything unresolved.
  it("treats found-nothing and fixed as resolved", () => {
    const report: RepairReport = {
      steps: [step("dns", "alreadyClean"), step("routes", "fixed", "removed 2 on neoconnect0")],
    };
    expect(unresolvedSteps(report)).toEqual([]);
  });

  /** The DNS cache flush always runs and always reports itself as done.
   *
   * Counting it would make every repair on a perfectly healthy machine
   * say "Repaired. Try connecting again." -- telling somebody their
   * machine had a problem it did not have, and sending them to reconnect
   * over a fault that was never here.
   */
  it("does not call a machine repaired when only the DNS cache was flushed", () => {
    const report: RepairReport = {
      steps: [
        step("dns", "alreadyClean"),
        step("routes", "alreadyClean"),
        step("dnsCache", "fixed", "flushed"),
      ],
    };
    expect(anythingFixed(report)).toBe(false);

    // And the control: a real removal alongside it does count.
    report.steps.push(step("dns", "fixed", "removed 1 rule(s)"));
    expect(anythingFixed(report)).toBe(true);
  });
});

describe("the diagnostics text a customer pastes", () => {
  /** It has to be readable before it is sent, which means it has to be
   * complete and it has to be text -- not JSON, and not a partial
   * summary with the interesting parts hidden. */
  it("names every field, with real values", () => {
    const text = diagnosticsToText(
      {
        ...EMPTY,
        ourAdapters: [
          { name: "neoconnect0", present: true },
          { name: "Neoxify-OpenVPN", present: false },
        ],
        otherVpnsUp: ["Kerio Virtual Network"],
        ourRoutes: ["neoconnect0: 0.0.0.0/1"],
        nrptRules: 2,
        splitTunnelFirewallRule: true,
        orphanedEngines: ["xray.exe (pid 4120)"],
        wireguardTunnelService: true,
        rasEntry: true,
        wfpFilters: 10,
        cleanupLogTail: ["2026-08-23 10:00:00 | repair | Tunnel DNS rule (NRPT): fixed -- removed 2 rule(s)"],
      },
      "0.9.28",
    );

    expect(text).toContain("app: 0.9.28");
    expect(text).toContain("service: 0.1.0");
    expect(text).toContain("neoconnect0=yes");
    expect(text).toContain("Neoxify-OpenVPN=no");
    expect(text).toContain("other VPNs up: Kerio Virtual Network");
    expect(text).toContain("routes on our adapters: neoconnect0: 0.0.0.0/1");
    expect(text).toContain("tunnel DNS rules present: 2");
    expect(text).toContain("split-tunnel firewall rule: yes");
    expect(text).toContain("orphaned engines: xray.exe (pid 4120)");
    expect(text).toContain("wireguard tunnel service: yes");
    expect(text).toContain("entry in Windows VPN list: yes");
    expect(text).toContain("our WFP filters: 10");
    expect(text).toContain("cleanup.log (most recent last):");
  });

  /** A healthy machine still produces something readable.
   *
   * The control for the test above, and a real case: an empty list has
   * to read as "none" rather than as a blank after a colon, which is
   * indistinguishable from a field that failed to render.
   */
  it("says none rather than nothing when there is nothing", () => {
    const text = diagnosticsToText(EMPTY, "0.9.28");
    expect(text).toContain("other VPNs up: none");
    expect(text).toContain("routes on our adapters: none");
    expect(text).toContain("orphaned engines: none");
    expect(text).toContain("tunnel DNS rules present: 0");
    expect(text).not.toContain("undefined");
    // Nothing to show means the log section is omitted entirely rather
    // than left as an empty heading.
    expect(text).not.toContain("cleanup.log");
  });

  /** The privacy boundary, asserted from the outside.
   *
   * The service composes this from named fields and never from a
   * profile, a config or a credential store -- but this is the text that
   * actually leaves the machine, so the check belongs here too. If a
   * future field ever carried one of these words, this is where it
   * surfaces before a customer pastes it into a ticket.
   */
  it("carries nothing that looks like a credential", () => {
    const text = diagnosticsToText(
      {
        ...EMPTY,
        cleanupLogTail: ["2026-08-23 10:00:00 | reap orphaned engines | ended C:\\Users\\<user>\\x\\xray.exe (pid 1)"],
      },
      "0.9.28",
    ).toLowerCase();

    for (const forbidden of ["privatekey", "private_key", "password", "secret", "token", "uuid", "begin "]) {
      expect(text).not.toContain(forbidden);
    }
    // And the control: the redaction the service applies survives into
    // the text unchanged, rather than being undone by the formatting.
    expect(text).toContain("c:\\users\\<user>\\");
  });
});
