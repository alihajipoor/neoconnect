/** Which credential a tunnel is on, kept where a screen that did not
 * bring it up can find it.
 *
 * The service reports the protocol it is running, not the credential --
 * not the server, not the country. Only the ladder pass that dialled
 * knows that, and it told the screen it ran on. The Dashboard unmounts
 * whenever Settings or Plans opens, so the screen mounted on return
 * started from its load's credential -- the pin, or the first -- adopted
 * the service's "connected", and the tiles, whose rule for a live tunnel
 * is to name the settled route, named the pin as where traffic was going.
 * On the VM (0.9.51): the pin the UK on Stealth Web, the ladder settled
 * on Singapore on Stealth, and after Settings and back the screen said
 * the UK and Stealth Web over a tunnel exiting in Singapore.
 *
 * So every dial is recorded here before its engine can come up, one per
 * app like the ladder's guard (`ladder-pass.ts`), and on disk as well,
 * because the service keeps a tunnel up when the window is closed and
 * the next start would otherwise name the pin over it just the same.
 * On disk before the dial goes out, not beside it: an app that exits or
 * crashes while the engine comes up leaves the service's tunnel up, and a
 * record still on the dial before -- the UK on Stealth, say, under a
 * tunnel to Singapore on Stealth -- passes the protocol check below and
 * names the wrong country at the next start.
 *
 * Only the ladder calls `vpn_connect`, and it records before calling, so
 * a tunnel the service reports up is, nearly always, the last recorded
 * dial's. Not always: the service refuses a dial that fails validation,
 * or one cancelled as it begins, before it takes the old engine down, so
 * a tunnel up when such a dial is made outlives a record that is not its
 * own until the ladder tears it down. And the service can say otherwise
 * about the protocol: a dial on another protocol than the service is
 * running is not the tunnel's, and then no route is named at all
 * (`credentialOnTunnel`).
 *
 * The phone keeps its own in memory (`passTunnel` in apps/mobile's
 * phone-pass.ts), which its screen adopts on return from Settings, and
 * this record for an app opened again over a tunnel the platform kept. */

import { loadTunnelDial, saveTunnelDial } from "./failover-store";

/** A dial, as far as naming its tunnel needs it. */
export interface TunnelDial {
  id: string;
  protocol: string;
}

/** The last dial this process made; null in an app just started. */
const lastDial: { current: TunnelDial | null } = { current: null };

/** The longest a dial waits for its record to reach the disk. A write
 * takes milliseconds against a connect's seconds; a store that does not
 * answer costs the name of a tunnel found up after a restart, never the
 * dial. */
export const DIAL_RECORD_WAIT_MS = 1_000;

export const tunnelCredential = {
  /** A pass is about to dial `credential`: from here a tunnel the service
   * reports up is on it. Kept in memory at once -- a screen that asks from
   * here on is told -- and settled once the record is on disk, or after
   * `DIAL_RECORD_WAIT_MS`; the dial waits for that. Never rejects. */
  async dialling(credential: { id: string; protocol: string }): Promise<void> {
    const dial = { id: credential.id, protocol: credential.protocol };
    lastDial.current = dial;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      saveTunnelDial(dial),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DIAL_RECORD_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
  },

  /** The last dial: this process's own, or, in an app just started, the
   * one recorded on disk. Null when there is none to be had. */
  async last(): Promise<TunnelDial | null> {
    return lastDial.current ?? (await loadTunnelDial());
  },

  /** For tests: an app just started -- nothing in memory, the disk left
   * as it is. */
  reset(): void {
    lastDial.current = null;
  },
};

/** Which of the credentials a screen holds the tunnel the service
 * reports up is on: the last dial's, found by id, when the service's
 * protocol agrees with it. Null when it cannot be said -- nothing dialled
 * that this app remembers, a dial this screen holds no credential for
 * (another account's, or one withdrawn since), or a service running
 * another protocol than the dial's. Never guessed from the protocol: two
 * routes on one protocol are two countries.
 *
 * A service that names no protocol does not contradict the dial. */
export function credentialOnTunnel<T extends { id: string; protocol: string }>(
  dial: TunnelDial | null,
  serviceProtocol: string | null | undefined,
  held: readonly T[],
): T | null {
  if (dial === null) return null;
  if (serviceProtocol && serviceProtocol !== dial.protocol) return null;
  return held.find((c) => c.id === dial.id) ?? null;
}
