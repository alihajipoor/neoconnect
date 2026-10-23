/** The session timer for a tunnel this window did not bring up.
 *
 * The main page's timer counts from when this app's own connect landed.
 * A tunnel found already up when the window opens -- the app restarted
 * over a session the service kept -- used to show "Connected" in words,
 * because nothing said how long it had been up and inventing a start
 * from the moment the window opened would be a number nobody measured.
 * The service now reports how long the session's engine has been up
 * (`session_secs`, on its own monotonic clock); the start is that many
 * seconds before the status was read. Nothing when it said nothing. */

/** When the reported session began, on this machine's clock, or null when
 * the status gave no usable age. */
export function adoptedSince(status: { sessionSecs?: unknown }, readAt: number): number | null {
  const secs = status.sessionSecs;
  if (typeof secs !== "number" || !Number.isFinite(secs) || secs < 0) return null;
  return readAt - Math.floor(secs) * 1000;
}
