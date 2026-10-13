import type { VpnStatus } from "./connection-evidence";

/** Whether a full-tunnel rung whose egress check failed deserves one more
 * check, because the service let go of the rung's own IPv4 confinement
 * while the check ran.
 *
 * The service's plan-error valve (K5) lets go of a confinement the tunnel
 * engine itself was refused by -- a wrong permit, which looks exactly like
 * censorship from here. It trips within the egress check's own seconds:
 * the check is what makes the engine dial. The ladder judged the rung on
 * that one check, six seconds on a rung with another behind it, so a
 * protocol our own filter had broken was dropped as if the network had
 * blocked it -- which this project does not do -- even though the filter
 * was gone by then. Confined before the check and not confined after it,
 * on a tunnel still up, is that case: the failure may be ours, and the
 * tunnel now runs as it would have without the confinement.
 *
 * Nothing else earns a second look: a check that passed; a confinement
 * that never went in (not ours to retry); a tunnel the service no longer
 * reports up; a service that did not answer. */
export function egressWorthAnotherLook(
  confinedBefore: boolean | null | undefined,
  after: Pick<VpnStatus, "connected" | "ipv4Confined"> | null,
  egressState: string,
): boolean {
  return (
    egressState !== "throughTunnel" &&
    confinedBefore === true &&
    after !== null &&
    after.connected &&
    after.ipv4Confined === false
  );
}
