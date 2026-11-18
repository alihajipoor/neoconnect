/** Pure helpers for laying out service-check counts, on the customer
 * page and the fleet page (/service-checks). No React, so each can be
 * unit tested; none changes what a count means. */

export interface ServiceColumn {
  key: string;
  label: string;
}

/** The columns: the known services in their order, then any key the
 * counts carry that the list does not (a result from the previous list),
 * under its own key. */
export function serviceOrder(known: ServiceColumn[], keys: string[]): ServiceColumn[] {
  const out: ServiceColumn[] = [];
  const seen = new Set<string>();
  for (const s of known) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    out.push(s);
  }
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label: key });
  }
  return out;
}

/** How a "reachable of results" cell reads. Quiet red only when fewer
 * than half were reachable over at least three results: one bad run of
 * one service is not a pattern, and the cell still shows its count. */
export type CellTone = "empty" | "problem" | "all" | "some";

export const PROBLEM_MIN_RESULTS = 3;

export function cellTone(ok: number, failed: number): CellTone {
  const total = ok + failed;
  if (total <= 0) return "empty";
  if (total >= PROBLEM_MIN_RESULTS && ok * 2 < total) return "problem";
  return failed === 0 ? "all" : "some";
}

/** Reachable and all results, summed over rows of per-service counts. */
export function reachableTotals(rows: { perService: { ok: number; failed: number }[] }[]): { ok: number; total: number } {
  let ok = 0;
  let total = 0;
  for (const row of rows) {
    for (const s of row.perService) {
      ok += s.ok;
      total += s.ok + s.failed;
    }
  }
  return { ok, total };
}

/** Where the failures stopped: "failed at name lookup" for one failure,
 * "most failed at ..." for several (the backend names the commonest
 * stage, ties broken alphabetically). */
export function failStageText(failed: number, stage: string): string {
  return failed === 1 ? `failed at ${stage}` : `most failed at ${stage}`;
}

/** "86%", or "" with nothing to divide. A share that rounds to 100 or 0
 * while not all or none is said as ">99%" / "<1%". */
export function percentText(part: number, whole: number): string {
  if (whole <= 0) return "";
  const share = (part / whole) * 100;
  if (part > 0 && share < 1) return "<1%";
  if (part < whole && share > 99) return ">99%";
  return `${Math.round(share)}%`;
}

/** The fleet page's windows, in hours. */
export const CHECK_WINDOWS = [
  { value: 24, label: "24 hours" },
  { value: 168, label: "7 days" },
] as const;

export function parseCheckHours(value: string | undefined): number {
  const n = Number(value);
  return CHECK_WINDOWS.some((w) => w.value === n) ? n : 24;
}

/** A link to the fleet page; the default window is left out. */
export function serviceChecksHref(hours: number): string {
  return hours === 24 ? "/service-checks" : `/service-checks?hours=${hours}`;
}
