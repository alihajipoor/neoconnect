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
 * Only the ladder calls `vpn_connect`, and it records before calling, so
 * a tunnel the service reports up is the last recorded dial's -- unless
 * the service says otherwise, which it can about the protocol: a dial on
 * another protocol than the service is running is not the tunnel's, and
 * then no route is named at all (`credentialOnTunnel`).
 *
 * The phone keeps its own (`passTunnel` in apps/mobile's phone-pass.ts),
 * which its screen already adopts on return from Settings. */

import { loadTunnelDial, saveTunnelDial } from "./failover-store";

/** A dial, as far as naming its tunnel needs it. */
export interface TunnelDial {
  id: string;
  protocol: string;
}

/** The last dial this process made; null in an app just started. */
const lastDial: { current: TunnelDial | null } = { current: null };

export const tunnelCredential = {
  /** A pass is about to dial `credential`: from here a tunnel the service
   * reports up is on it. Kept in memory at once and written to disk in the
   * background. */
  dialling(credential: { id: string; protocol: string }): void {
    const dial = { id: credential.id, protocol: credential.protocol };
    lastDial.current = dial;
    void saveTunnelDial(dial);
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
