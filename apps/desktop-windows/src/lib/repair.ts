import { invoke } from "@tauri-apps/api/core";
import { SERVICE_CALL_TIMEOUT_MS, withTimeout } from "./service-call";

/** "Repair my network", and the diagnostics that go beside it.
 *
 * # What this is for
 *
 * Customers have reported, more than once, that after using the client
 * their networking stays broken until they reset Windows network
 * settings and uninstall the app. Every residue behind that is fixed
 * by now -- but each fix runs on a path a broken machine may never
 * reach, and until this existed the only cure a customer had was
 * running netsh and registry commands by hand. That is what "I had to
 * reset my network settings" in their reports actually means.
 *
 * The privileged work all happens in the helper service (see
 * `service/src/engines/repair.rs`). This module is only the call, plus
 * the two things the UI needs that the service cannot provide: a
 * deadline of its own, and the command to print when the service is the
 * thing that is broken.
 */

/** What one step did.
 *
 * Four outcomes, not a boolean, and `unknown` is not a quiet success:
 * a step that could not look is not a step that found the machine
 * clean. The app's rule is that it does not report a state it has not
 * verified, and this is where that rule is carried across the wire. */
export type RepairOutcome =
  | { outcome: "alreadyClean" }
  | { outcome: "fixed"; detail: string }
  | { outcome: "failed"; detail: string }
  | { outcome: "unknown"; detail: string };

export interface RepairStep {
  /** Keys the translated label. Never rendered raw -- the customer
   * reading this may not read English. */
  id: string;
  /** English wording, kept for the technical-details view and for
   * anything pasted to support. */
  label: string;
  outcome: RepairOutcome["outcome"];
  detail?: string;
}

export interface RepairReport {
  steps: RepairStep[];
}

/** How long the app waits for the whole pass.
 *
 * Deliberately far longer than any other service call. The repair is
 * nine steps, several of which shell out to PowerShell or netsh, and
 * each of those is separately bounded inside the service. On the
 * machine somebody actually presses this on -- where those cmdlets are
 * often the thing misbehaving -- the worst case is several of those
 * budgets end to end.
 *
 * A little longer than the Rust side's own deadline (195s), so a
 * timeout surfaces as the service's sentence about being stuck rather
 * than as this one racing it. Both moved up by 45s together when the
 * NRPT clear's budget did; the gap between them is the point, so they
 * have to move as a pair. */
const REPAIR_TIMEOUT_MS = 205_000;

/** Everything a step's outcome can be, plus whether the pass as a whole
 * counts as a success.
 *
 * `alreadyClean` and `fixed` are the only two that do. Anything else
 * leaves something on the machine, or leaves a question unanswered, and
 * the customer is told which. */
export function unresolvedSteps(report: RepairReport): RepairStep[] {
  return report.steps.filter((s) => s.outcome !== "alreadyClean" && s.outcome !== "fixed");
}

/** The steps that looked, found something of ours, and could not remove
 * it.
 *
 * The only steps that make a repair a failure, and deliberately separate
 * from {@link indeterminateSteps}: the two are different claims about
 * the machine. This one asserts "we checked and it is still there",
 * which the step actually established. Mirrors `RepairReport::failed`
 * on the Rust side. */
export function failedSteps(report: RepairReport): RepairStep[] {
  return report.steps.filter((s) => s.outcome === "failed");
}

/** The steps that could not complete, so they say nothing either way.
 *
 * A helper that was killed at its timeout establishes *nothing* -- not
 * that the residue is gone, and not that it is still there. This used to
 * be folded into {@link unresolvedSteps} and painted the whole result in
 * the destructive colour, so a repair in which every check succeeded and
 * one merely timed out told the customer it had failed.
 *
 * That is the worst outcome this screen can produce. The people who
 * reach it have networking that is already broken and machines slow
 * enough to hit the timeout in the first place, and this is the last
 * thing offered to them before a network reset and an uninstall.
 * Mirrors `RepairReport::indeterminate` on the Rust side. */
export function indeterminateSteps(report: RepairReport): RepairStep[] {
  return report.steps.filter((s) => s.outcome === "unknown");
}

/** Whether anything was actually found and removed.
 *
 * Distinguished from "clean" because the two need different words: a
 * machine that had nothing wrong should not be told it was repaired,
 * and a machine that was repaired should be told to try connecting
 * again. */
export function anythingFixed(report: RepairReport): boolean {
  // The DNS cache flush always runs and always reports itself as done,
  // so counting it would make every single repair look like it found
  // something. It is the one step with nothing to find.
  return report.steps.some((s) => s.outcome === "fixed" && s.id !== "dnsCache");
}

export interface Diagnostics {
  serviceVersion: string;
  ourAdapters: { name: string; present: boolean }[];
  otherVpnsUp: string[];
  ourRoutes: string[];
  nrptRules: number;
  splitTunnelFirewallRule: boolean;
  orphanedEngines: string[];
  wireguardTunnelService: boolean;
  rasEntry: boolean;
  wfpFilters: number;
  cleanupLogTail: string[];
}

/** Runs the repair through the service.
 *
 * Rejects when the service cannot be reached at all -- which is exactly
 * the case the repair is most needed in, and why the UI answers that
 * rejection by showing [`repairCommandLine`] rather than an error. */
export async function repairNetwork(): Promise<RepairReport> {
  return withTimeout(invoke<RepairReport>("vpn_repair"), "the repair", REPAIR_TIMEOUT_MS);
}

export async function collectDiagnostics(): Promise<Diagnostics> {
  return withTimeout(
    invoke<Diagnostics>("vpn_diagnostics"),
    "diagnostics",
    // Longer than an ordinary status poll: it enumerates routes and
    // NRPT rules, which means PowerShell. Still short, because this is
    // a person waiting on a button.
    SERVICE_CALL_TIMEOUT_MS * 5,
  );
}

/** The elevated command that does the same thing without the app.
 *
 * Resolved by the Rust side from the running executable's own location,
 * because a per-user install is not under Program Files and naming a
 * path that does not exist on the customer's machine is worse than
 * naming none. */
export async function repairCommandLine(): Promise<string> {
  try {
    return await invoke<string>("repair_command_line");
  } catch {
    // The command is still the answer even if the app cannot work out
    // where it lives -- the customer can find the file from the name.
    return '"C:\\Program Files\\Neoxify\\resources\\neoconnect-service.exe" repair';
  }
}

/** The snapshot as text a customer can read before pasting it.
 *
 * Plain lines rather than JSON, on purpose. It goes into a support
 * message that a person reads, and it has to be checkable at a glance
 * by the customer sending it -- which is the only real guarantee that
 * nothing private is in it. Everything here is a count, a yes/no, or a
 * name this product chose; nothing is read out of a config, a profile
 * or a credential store.
 */
export function diagnosticsToText(d: Diagnostics, appVersion: string): string {
  const yesNo = (value: boolean) => (value ? "yes" : "no");
  const list = (values: string[]) => (values.length ? values.join(", ") : "none");

  const lines = [
    "Neoxify diagnostics",
    `app: ${appVersion}`,
    `service: ${d.serviceVersion}`,
    `our adapters: ${list(d.ourAdapters.map((a) => `${a.name}=${yesNo(a.present)}`))}`,
    `other VPNs up: ${list(d.otherVpnsUp)}`,
    `routes on our adapters: ${list(d.ourRoutes)}`,
    `tunnel DNS rules present: ${d.nrptRules}`,
    `split-tunnel firewall rule: ${yesNo(d.splitTunnelFirewallRule)}`,
    `orphaned engines: ${list(d.orphanedEngines)}`,
    `wireguard tunnel service: ${yesNo(d.wireguardTunnelService)}`,
    `entry in Windows VPN list: ${yesNo(d.rasEntry)}`,
    `our WFP filters: ${d.wfpFilters}`,
  ];

  if (d.cleanupLogTail.length > 0) {
    lines.push("", "cleanup.log (most recent last):");
    for (const line of d.cleanupLogTail) lines.push(`  ${line}`);
  }
  return lines.join("\n");
}
