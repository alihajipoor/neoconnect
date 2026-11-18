import { Activity, Clock } from "lucide-react";
import type { CustomerActivity } from "@/lib/types";
import { protocolLabel } from "@/lib/protocol-labels";
import { ago, megabytes } from "@/lib/time";
import { cn } from "@/lib/utils";

/** Whether this customer is on the VPN right now, as far as the servers
 * can tell -- the top half of the overview's "Right now" card.
 *
 * "Connected" here is traffic, not a claim from the app: a usage record
 * that ended in the last 10 minutes and carried bytes. That is the only
 * evidence the backend has that a tunnel actually works, and the app's
 * own "Connected" has been wrong before. The flip side is worth saying on
 * the card, because it is what an operator will be asked about: a tunnel
 * that is up but idle, or that came up a minute ago, reads as not
 * connected until the next usage report lands.
 *
 * `now` is null when the activity endpoint failed. That is shown as
 * "could not load", never as "not connected" -- telling support someone
 * is offline because a request failed is exactly the kind of state report
 * this product does not make without evidence.
 */
export function RightNow({ now }: { now: CustomerActivity["now"] | null }) {
  if (now === null) {
    return (
      <p className="text-sm text-muted-foreground">
        Could not load this customer&apos;s activity. Their connection state is unknown, not offline.
      </p>
    );
  }
  const connected = now.connected;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div
          className={cn(
            "flex min-w-0 flex-col gap-1 rounded-lg border bg-card/40 px-3.5 py-3",
            connected ? "border-success/40" : "col-span-full border-white/8",
          )}
        >
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Status</p>
          {connected ? (
            <p className="flex items-center gap-2 text-lg leading-tight font-semibold text-success">
              <span className="size-2 rounded-full bg-success" aria-hidden="true" />
              Connected
            </p>
          ) : (
            <>
              <p className="flex items-center gap-2 text-lg leading-tight font-semibold">
                <span className="size-2 rounded-full bg-muted-foreground/50" aria-hidden="true" />
                Not connected
              </p>
              <p className="text-xs text-muted-foreground">No traffic through any server in the last 10 minutes.</p>
            </>
          )}
        </div>
        {connected && (
          <>
            <Detail label="Server" value={connected.nodeName} sub={protocolLabel(connected.protocol)} />
            <Detail
              label="Last traffic"
              value={ago(connected.lastTrafficAt)}
              sub={new Date(connected.lastTrafficAt).toLocaleString()}
            />
            <Detail label="Last 10 minutes" value={megabytes(connected.bytesLast10Min)} />
          </>
        )}
      </div>

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Clock className="size-3.5 shrink-0" aria-hidden="true" />
        {now.lastSeenAt ? (
          <span>
            Last seen {ago(now.lastSeenAt)} ({new Date(now.lastSeenAt).toLocaleString()})
          </span>
        ) : (
          <span>Last seen: never.</span>
        )}
      </p>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Activity className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        Worked out from the usage the servers report, so it trails real time a little. A connection that is up but
        idle, or only just started, shows as not connected until it carries traffic.
      </p>
    </div>
  );
}

function Detail({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-white/8 bg-card/40 px-3.5 py-3">
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="truncate text-lg leading-tight font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{sub}</p>}
    </div>
  );
}
