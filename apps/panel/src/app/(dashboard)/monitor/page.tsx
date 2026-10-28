import Link from "next/link";
import { Radar } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { requireStaff } from "@/lib/session";
import type { LiveMonitor } from "@/lib/types";
import { protocolLabel } from "@/lib/protocol-labels";
import { ago, megabytes } from "@/lib/time";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RefreshButton } from "./refresh-button";

/** Who is on the VPN right now.
 *
 * "On" means traffic: a usage record that ended in the last 10 minutes
 * and carried bytes, which is the only evidence the backend has that a
 * tunnel works. It undercounts on purpose rather than guessing -- someone
 * connected and idle, or connected a minute ago, is not on this list --
 * and the page says so, because "is my friend connected?" gets answered
 * from here.
 */
export default async function MonitorPage() {
  await requireStaff();

  // Caught rather than left to the error boundary: an empty list and a
  // failed read must not look alike on a page whose whole answer is
  // "who is connected".
  const live = await apiFetch<LiveMonitor>("/monitor/live").catch(() => null);
  const users = [...(live?.users ?? [])].sort(
    (a, b) => new Date(b.lastTrafficAt).getTime() - new Date(a.lastTrafficAt).getTime(),
  );
  // Counted by person, not by row: someone on two devices through two
  // servers is two rows and one customer.
  const people = new Set(users.map((user) => user.customerId)).size;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Live</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Customers whose traffic went through a server in the last 10 minutes, from the usage the
            servers report. Someone connected but idle, or connected only moments ago, does not show
            until they carry traffic.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {live && (
            <span className="text-xs text-muted-foreground" title={new Date(live.at).toLocaleString()}>
              As of {new Date(live.at).toLocaleTimeString()}
            </span>
          )}
          <RefreshButton />
        </div>
      </div>

      {live === null ? (
        <Card className="p-5 text-sm text-muted-foreground">
          Could not load who is connected. That is unknown right now, not nobody.
        </Card>
      ) : (
        <>
          <p className="text-sm tabular-nums">
            <span className="text-2xl font-semibold">{people}</span>{" "}
            <span className="text-muted-foreground">{people === 1 ? "customer" : "customers"} carrying traffic</span>
          </p>
          <div className="rounded-lg border border-white/8 bg-card/40">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Server</TableHead>
                  <TableHead>Protocol</TableHead>
                  <TableHead>Last traffic</TableHead>
                  <TableHead className="text-right">Last 10 minutes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                      <Radar className="mx-auto mb-2 size-5 opacity-50" />
                      Nobody has carried traffic in the last 10 minutes.
                    </TableCell>
                  </TableRow>
                ) : (
                  users.map((user) => (
                    // One customer can be on two servers at once (two
                    // devices), so the key carries the server and protocol.
                    <TableRow key={`${user.customerId}-${user.nodeName}-${user.protocol}`}>
                      <TableCell className="font-medium">
                        <Link href={`/customers/${user.customerId}`} className="hover:text-primary hover:underline">
                          {user.email}
                        </Link>
                      </TableCell>
                      <TableCell className="text-sm">{user.nodeName}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{protocolLabel(user.protocol)}</TableCell>
                      <TableCell className="text-sm" title={new Date(user.lastTrafficAt).toLocaleString()}>
                        {ago(user.lastTrafficAt)}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">{megabytes(user.bytesLast10Min)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
