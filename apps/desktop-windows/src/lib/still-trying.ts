import { useEffect, useState } from "react";

/** How long a screen waits on Neoxify before it says it is still trying.
 *
 * Eight seconds, because that is where every request used to give up.
 * Since reads are given up to twenty seconds an address (`SLOW_ANSWER_MS`
 * in api.ts), and a sign-in up to forty-five in all, a screen can now sit
 * on "Loading..." or "Signing in..." well past the point where it used to
 * show an error. Without a word it reads as frozen, and a frozen app is
 * closed and reopened -- which starts the wait again from nothing. The
 * note says only what is true at that moment: the wait is longer than
 * usual and has not ended. It does not say that nothing answered, which
 * may not be so. */
export const STILL_TRYING_AFTER_MS = 8_000;

/** Whether `waiting` has been true for `STILL_TRYING_AFTER_MS` without a
 * break.
 *
 * Starts again from nothing each time `waiting` goes true, so a second
 * sign-in after a failed one does not open with the first one's note. */
export function useStillTrying(waiting: boolean): boolean {
  const [long, setLong] = useState(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setLong(true), STILL_TRYING_AFTER_MS);
    return () => {
      clearTimeout(timer);
      setLong(false);
    };
  }, [waiting]);
  // Read with `waiting` as well: between the wait ending and the cleanup
  // above running, `long` can still be true for one render.
  return waiting && long;
}
