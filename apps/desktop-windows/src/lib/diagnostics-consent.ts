/** Whether the fuller diagnostics may be sent yet.
 *
 * Two rules, one place:
 *
 * - Desktop (Windows, Linux, the macOS shell): yes, from the first run.
 *   The published privacy page describes everything these reports hold,
 *   no store rule asks a desktop app for an in-app acceptance, and the
 *   desktop's connection reports have always gone without one. A one-time
 *   notice with an OK gate was built first, as a reviewer's precaution;
 *   the owner chose on 2026-11-19 to have no card at all, because anyone
 *   who ignored it sent none of the details support needs.
 * - Phones: only after the prominent disclosure has been accepted
 *   (apps/mobile ProminentDisclosure, version 2 and later). The stores
 *   require that screen before sign-in, and the phone app sets it as the
 *   source here. Until then a report goes exactly as it did before the
 *   feature: no `details`, no rung `ms` (attempts.ts), no service check
 *   reported or run by itself (service-check.ts), no end-of-session
 *   report. Fails closed: a source that throws is "not yet".
 *
 * A bundle the customer sends from the Support screen is not held by
 * this on any platform: they see exactly what it carries before they
 * press Send. */

const DESKTOP: () => Promise<boolean> = () => Promise.resolve(true);

let source: () => Promise<boolean> = DESKTOP;
let known = false;

/** Where the answer comes from on a phone: its accepted disclosure. */
export function setDiagnosticsConsentSource(read: () => Promise<boolean>): void {
  source = read;
  known = false;
}

/** Whether the new details may go. Once yes it stays yes for the run. */
export async function diagnosticsAllowed(): Promise<boolean> {
  if (known) return true;
  try {
    known = (await source()) === true;
  } catch {
    known = false;
  }
  return known;
}

/** Tests only: start again from the desktop rule, or from a given source. */
export function resetDiagnosticsConsentForTests(read?: () => Promise<boolean>): void {
  source = read ?? DESKTOP;
  known = false;
}
