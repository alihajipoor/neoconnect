/** Bounding calls to the helper service, which can otherwise never
 * return.
 *
 * The service is reached over a named pipe, and the Rust side reads the
 * reply line with no deadline of its own. A service that accepts the
 * connection and then never answers therefore leaves the promise
 * pending for the life of the process -- and with it every piece of UI
 * that was waiting on the answer.
 *
 * That is not hypothetical. The dashboard sat on "Disconnecting..."
 * indefinitely with no engine running, no tunnel adapter present and
 * vpn_status reporting nothing connected, and the only way out was
 * killing the app from Task Manager. Nothing was wrong with the tunnel;
 * a state that could only be left by a reply that never came was wrong.
 *
 * Lives in its own module rather than beside its callers so it can be
 * tested without a Tauri runtime -- a mechanism whose whole job is to
 * behave correctly when nothing else answers is a poor thing to take on
 * faith.
 */

/** How long any one call may take before the caller stops waiting.
 *
 * Far longer than the service needs to answer a status or a teardown,
 * so a timeout means something is genuinely wrong rather than merely
 * slow. */
export const SERVICE_CALL_TIMEOUT_MS = 6_000;

/** Marker carried by the rejection a timed-out call produces.
 *
 * The two failures need different words: a service that refused says
 * why, and that reason is worth showing, while a service that never
 * answered leaves a teardown that may still be in progress. Without a
 * way to tell them apart, the generic classifier sends anything
 * containing "timeout" to "Couldn't reach this server" -- a claim about
 * the node that nothing here measured. */
export const SERVICE_TIMEOUT_MARKER = "did not answer in time";

export function isServiceTimeout(err: unknown): boolean {
  return String(err).includes(SERVICE_TIMEOUT_MARKER);
}

/** Frees the caller from a call it cannot otherwise abandon.
 *
 * The underlying work keeps running -- there is no way to cancel an
 * invoke -- so this only releases whoever was waiting. That is the whole
 * point: the waiter is what the customer is looking at.
 */
export function withTimeout<T>(
  work: Promise<T>,
  label: string,
  budgetMs: number = SERVICE_CALL_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} ${SERVICE_TIMEOUT_MARKER} (${budgetMs}ms)`)),
      budgetMs,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
