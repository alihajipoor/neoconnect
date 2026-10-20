/** Where a connect pass is on its ladder, for the line under the state:
 * "Trying Germany · Stealth · 3 of 8" (design-system.md, 4.6).
 *
 * Set by the pass as it starts each rung and cleared when it ends, beside
 * the guard in ladder-pass.ts and for the same reason: a pass outlives the
 * screen that started it whenever Settings opens, and the screen mounted
 * on return has to show where it is. Only the pass that owns the guard
 * writes; a superseded one is ignored.
 *
 * Facts only -- which rung, of how many, on which route. The place and the
 * protocol are worded on screen in the app's language. Shown only while
 * more than one rung is there to try: "1 of 1" says nothing. */

import type { Protocol } from "./types";

export interface LadderRung {
  /** The pass's generation (`ladderPass.generation`). */
  readonly pass: number;
  /** Zero-based. */
  readonly index: number;
  readonly total: number;
  readonly routeId: string;
  readonly protocol: Protocol;
  readonly transport?: string;
}

let rung: LadderRung | null = null;
const listeners = new Set<() => void>();

function publish(next: LadderRung | null): void {
  rung = next;
  for (const listener of [...listeners]) listener();
}

export const ladderProgress = {
  current(): LadderRung | null {
    return rung;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** The pass `pass` has begun this rung. */
  rung(next: LadderRung): void {
    if (rung !== null && rung.pass > next.pass) return;
    publish(next);
  },
  /** The pass `pass` has ended; a newer pass's rung stays. */
  ended(pass: number): void {
    if (rung !== null && rung.pass === pass) publish(null);
  },
  /** For tests. */
  resetForTests(): void {
    rung = null;
    listeners.clear();
  },
};

/** Whether the line is worth showing: a pass, with somewhere else to go. */
export function showsProgress(current: LadderRung | null): current is LadderRung {
  return current !== null && current.total > 1;
}
