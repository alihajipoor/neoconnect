/** Whether the app went to the background while something was running.
 *
 * On iOS the app is suspended seconds after it is backgrounded -- the
 * tunnel lives in a separate extension and keeps nothing of the app
 * awake. A request in flight then is frozen, and when the app comes
 * back its timers fire at once: the refresh reports "no answer within
 * 6000ms" and the trace says the addresses timed out, about a network
 * that was never given the chance to answer. Android keeps the process
 * running while its VpnService is up, and a desktop window is never
 * suspended, so the same failure there means something else.
 *
 * That is one of the explanations on the table for why the iOS builds'
 * reports fail far more often than Android's, and nothing in a report
 * could confirm or rule it out. This lets a report say so.
 *
 * Returns a function that stops watching and answers whether the page
 * was hidden at any point since the call. Without a document (tests,
 * any non-browser context) the answer is always false. */
export function watchBackground(): () => boolean {
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") return () => false;
  let hidden = document.visibilityState === "hidden";
  const onChange = () => {
    if (document.visibilityState === "hidden") hidden = true;
  };
  document.addEventListener("visibilitychange", onChange);
  return () => {
    document.removeEventListener("visibilitychange", onChange);
    return hidden;
  };
}
