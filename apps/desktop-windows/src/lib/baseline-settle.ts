import {
  askedAroundTunnel,
  BASELINE_HEDGE_MS,
  baselineBlockPage,
  captureBaselineIp,
  EGRESS_TIMEOUT_MS,
  type BaselineIp,
  type TunnelServer,
} from "./egress";
import { isDemoted } from "./endpoint-demotion";

/** How often the settle asks again while ordinary networking is coming
 * back after a teardown. */
export const SETTLE_INTERVAL_MS = 400;

/** Waits until the machine can reach the outside world unaided, and
 * returns the address the world sees. The Windows ladder's, before each
 * rung; kept here, apart from the screen, so its timing can be tested.
 *
 * Serves two purposes at once, which is why it is one function. It
 * proves the previous engine's routes are really gone before the next
 * one is tried -- without this, one failed attempt poisoned every
 * attempt after it, and a whole failover run reported "no traffic got
 * through" while the server never saw so much as a connection. And the
 * moment it succeeds is the only correct moment to take a baseline: an
 * address captured through a live tunnel makes the next comparison read
 * every working connection as a leak.
 *
 * Null means we could not reach our own API even unprotected. That is
 * not a reason to refuse to connect -- their network may be fine and
 * ours may not be -- so the caller proceeds without a baseline and falls
 * back to handshake evidence.
 *
 * **Bounded, which it was not.** The budget used to be checked only
 * between whole walks of the endpoint list, and one walk is a dozen
 * endpoints at six seconds each when the bare network filters them. So
 * a 2.5-second settle could cost a minute, once per candidate, and a
 * pass ran far past `LADDER_MAX_MS` -- whose guard then expired under a
 * pass still dialling, and a press started a second ladder beside it.
 *
 * Now `known`, an endpoint that already answered on this network (the
 * pass's previous baseline, or the one taken when the screen loaded), is
 * asked alone first, within the budget: it is the one that is going to
 * answer, and it is the one the `sameEndpointOnly` check will ask --
 * unless this network has since shown it will not. One the API's own
 * requests have demoted here (`isDemoted`: it timed out, or its name went
 * to the block page) is not asked first at all, and one whose name the
 * settle's own look finds on the block page is not asked again: the settle
 * goes straight on to the hedged walk, which still asks it where this
 * network's order puts it. Asked first anyway, a demoted endpoint that
 * hangs held the first rung for its two seconds, and the last rung after
 * a teardown for seven, where a mirror that answers at once was next in
 * the walk; and a name on the block page was asked again every 400 ms
 * until the budget was gone. Only if the known endpoint does not answer,
 * or is passed over, is the whole list walked -- in the order the API's own
 * requests use on this network, with the addresses that have lately
 * failed here last (`BARE_WALK` in egress.ts). Which endpoint supplies
 * the baseline does not matter so long as the comparison asks it again
 * (`VerifyOptions.baselineFirst`); a mirror that reports its own node's
 * address is passed over wherever it comes in the order, by the
 * self-report rule and `nodeAddresses`, which is what the list's fixed
 * order used to be kept for. The walk has a
 * ceiling of its own: one endpoint timeout past the budget, or two for a
 * pass with nothing known yet, so a first endpoint that is blocked on
 * the bare network still leaves the next one time to answer.
 *
 * `tunnelServer` is the server of the rung about to be dialled. Where
 * this client reaches it around the tunnel, no baseline comes from an
 * endpoint on it: once that tunnel is up, the endpoint answers with this
 * same home address -- read as "NOT protected" over a working tunnel --
 * so the next endpoint supplies it instead. A `known` endpoint on it is
 * not asked at all, and the walk gets the longer ceiling, as with
 * nothing known. See `TunnelServer` in egress.ts.
 *
 * The walk is hedged (`BaselineOptions.hedgeMs`). The known endpoint is
 * passed over exactly where it mattered most: in Iran, where the panel
 * hosts are filtered and the last endpoint that worked is a mirror --
 * often the mirror of the node being dialled. Walked strictly in turn,
 * the list then spent its whole twelve seconds timing out the two panel
 * hosts at its head and ended with no baseline, "not confirmed", before
 * it reached the next mirror, which would have answered at once.
 *
 * `nodeAddresses` are every node the account holds a credential on. A
 * reading of one is never this machine's own address (see
 * `BaselineOptions.nodeAddresses`); the phones always passed them, and
 * now that the comparisons ask the baseline's endpoint first, Windows
 * needs them as much.
 *
 * **Asked again only after a teardown** (`afterTeardown`). The asking
 * again is what waits out a previous engine's routes; where nothing has
 * been torn down -- the first rung of a pass started with nothing up --
 * there is nothing to wait out, and a walk that found nothing answering
 * finds the same the next time. It used to ask again anyway, every 400
 * ms until the walk's ceiling: on the test VM, with every name on the
 * block page and the panel hosts refused, the walk itself ended within a
 * second and the asking again took the connect to twelve. And after a
 * teardown, only within the budget the caller gives the network to come
 * back (`SETTLE_TIMEOUT_MS`, `FAILOVER_SETTLE_TIMEOUT_MS` on the
 * screen), not the walk's longer ceiling, which is there for endpoints
 * that hang rather than for asking again. */
export async function settleAndCaptureBaseline(
  budgetMs: number,
  known: BaselineIp | null,
  tunnelServer: TunnelServer,
  nodeAddresses: ReadonlySet<string>,
  afterTeardown: boolean,
): Promise<BaselineIp | null> {
  const deadline = Date.now() + budgetMs;
  const ask = known !== null && !askedAroundTunnel(known, tunnelServer) ? known : null;
  if (ask !== null && !isDemoted(ask.from)) {
    // Looked at beside the first ask, which looks too and ends at the block
    // page without saying why; this says whether to ask again.
    let onBlockPage = false;
    void baselineBlockPage(ask.from).then((found) => {
      onBlockPage = found;
    });
    for (;;) {
      const ip = await captureBaselineIp({ only: ask.from, deadline, tunnelServer, nodeAddresses });
      if (ip !== null) return ip;
      if (!afterTeardown || Date.now() >= deadline || onBlockPage || isDemoted(ask.from)) break;
      await new Promise((r) => setTimeout(r, SETTLE_INTERVAL_MS));
    }
  }
  // The longer ceiling only with nothing known: a known endpoint passed
  // over for having failed here gives the walk no more time than asking it
  // would have, so no pass takes longer for it.
  const walkDeadline = Math.max(
    deadline,
    Date.now() + (ask === null ? 2 * EGRESS_TIMEOUT_MS : EGRESS_TIMEOUT_MS),
  );
  for (;;) {
    const ip = await captureBaselineIp({
      deadline: walkDeadline,
      tunnelServer,
      nodeAddresses,
      hedgeMs: BASELINE_HEDGE_MS,
    });
    if (ip !== null) return ip;
    if (!afterTeardown || Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, SETTLE_INTERVAL_MS));
  }
}
