import { Activity, Clock } from "lucide-react";
import type { CustomerActivity } from "@/lib/types";
import { protocolLabel } from "@/lib/protocol-labels";
import { ago, megabytes } from "@/lib/time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** Whether this customer is on the VPN right now, as far as the servers
 * can tell.
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
export function RightNowCard({ now }: { now: CustomerActivity["now"] | null }) {
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">Right now</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {now === null ? (
          <p className="text-sm text-muted-foreground">
            Could not load this customer&apos;s activity. Their connection state is unknown, not
            offline.
          </p>
        ) : (
          <>
            {now.connected ? (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <span className="flex items-center gap-2 text-sm font-medium text-success">
                  <span className="size-2 rounded-full bg-success" />
                  Connected
                </span>
                <Detail label="Server" value={now.connected.nodeName} />
                <Detail label="Protocol" value={protocolLabel(now.connected.protocol)} />
                <Detail
                  label="Last traffic"
                  value={ago(now.connected.lastTrafficAt)}
                  title={new Date(now.connected.lastTrafficAt).toLocaleString()}
                />
                <Detail label="Last 10 minutes" value={megabytes(now.connected.bytesLast10Min)} />
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm">
                <span className="size-2 rounded-full bg-muted-foreground/50" />
                <span className="font-medium">Not connected</span>
                <span className="text-muted-foreground">
                  -- no traffic through any server in the last 10 minutes.
                </span>
              </div>
            )}

            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock className="size-3.5" />
              {now.lastSeenAt ? (
                <span title={new Date(now.lastSeenAt).toLocaleString()}>
                  Last seen {ago(now.lastSeenAt)} ({new Date(now.lastSeenAt).toLocaleString()})
                </span>
              ) : (
                <span>Last seen: never.</span>
              )}
            </p>

            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <Activity className="mt-px size-3.5 shrink-0" />
              Worked out from the usage the servers report, so it trails real time a little. A connection that is
              up but idle, or only just started, shows as not connected until it carries traffic.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Detail({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="truncate text-sm" title={title}>
        {value}
      </p>
    </div>
  );
}
