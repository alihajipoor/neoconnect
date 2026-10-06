/** What of ours can make a "no tunnel" answer untrustworthy for a moment.
 *
 * The service answers a status from the engine it holds -- unless its
 * owning thread is busy, and then from what Windows shows, which is an
 * adapter's presence for Xray and OpenVPN and whatever PowerShell
 * managed for IKEv2. Two things this app asks for cause exactly that:
 *
 *  - **A Custom-mode change** (`pushSplitTunnel`). Turning the mode on or
 *    off rebuilds the tunnel, and while it does the Xray adapter is gone
 *    and the owning thread is taken. A status asked meanwhile can come
 *    back `connected: false` over a tunnel that is about to be up again.
 *  - **The Custom-mode probe.** It holds the owning thread for seconds,
 *    so a status asked meanwhile is answered by the fallback.
 *
 * A current service marks the fallback's "no tunnel" itself (health
 * `unknown` rather than `down`), and the app reads only `down` as a
 * drop. A 0.9.43 service does not, and the app knows something no
 * service can: that it has just asked for one of these. So an answer
 * fetched while either was running, or that either began during, is not
 * evidence that a tunnel ended -- whichever service gave it.
 *
 * Pure apart from the clock, which every method takes as an argument
 * so the tests can drive it.
 */
export class Disturbances {
  private started = 0;
  /** What is running: when it began, and how long it can be believed to
   * be running at most. */
  private readonly running = new Map<number, { at: number; capMs: number }>();

  /** Something has begun. Call the returned function when it ends --
   * from a `finally`, so a failure ends it too.
   *
   * `capMs` is the longest it can be believed to be running. A call
   * that never answers must not switch the drop check off for good, so
   * past this it no longer counts as running -- though an answer whose
   * fetch it overlapped still counts as disturbed, by `since`. */
  begin(capMs: number, now: number = Date.now()): () => void {
    const id = ++this.started;
    this.running.set(id, { at: now, capMs });
    return () => {
      this.running.delete(id);
    };
  }

  /** Taken before asking the service, to hand to `since` afterwards. */
  mark(): number {
    return this.started;
  }

  /** Whether anything is running now, within its cap. */
  busy(now: number = Date.now()): boolean {
    for (const { at, capMs } of this.running.values()) {
      if (now - at < capMs) return true;
    }
    return false;
  }

  /** Whether an answer fetched since `mark` may have been caught by one:
   * something began after the mark, or something is running now. */
  since(mark: number, now: number = Date.now()): boolean {
    return this.started !== mark || this.busy(now);
  }
}

/** The longest a Custom-mode change is believed to be running: the Tauri
 * layer gives up on a reply after 45 seconds (`REPLY_TIMEOUT` in
 * `src-tauri/src/vpn.rs`), and the service's connect budget, which a
 * rebuild runs under, is 38. */
export const CUSTOM_MODE_CHANGE_CAP_MS = 50_000;

/** The longest the probe is believed to be running. The probe takes
 * seconds; past ten, one that has not answered is not allowed to hold
 * off the drop check any longer. */
export const PROBE_CAP_MS = 10_000;

/** The one instance, shared by the Custom-mode push and the dashboard. */
export const statusDisturbances = new Disturbances();
