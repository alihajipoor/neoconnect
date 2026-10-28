import type { CustomerTrafficRow } from "@/lib/types";
import { protocolLabel } from "@/lib/protocol-labels";
import { megabytes } from "@/lib/time";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** Where this customer's traffic actually went, per day, server and
 * protocol, for the last 14 days.
 *
 * The connection log says what the app tried; this says what carried
 * data. The two disagree more often than they should -- an app that
 * reports "connected" on a server that shows nothing here is the
 * interesting case -- so both are on the page. Days are UTC, because the
 * usage behind them is bucketed in UTC.
 */
export function TrafficCard({ traffic }: { traffic: CustomerTrafficRow[] | null }) {
  const rows = [...(traffic ?? [])].sort(
    (a, b) =>
      b.day.localeCompare(a.day) || a.nodeName.localeCompare(b.nodeName) || a.protocol.localeCompare(b.protocol),
  );
  const totalUp = rows.reduce((sum, row) => sum + Number(row.bytesUp), 0);
  const totalDown = rows.reduce((sum, row) => sum + Number(row.bytesDown), 0);

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">
          Traffic by server
          {rows.length > 0 && (
            <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">
              14 days: {megabytes(totalUp)} up, {megabytes(totalDown)} down
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {traffic === null ? (
          <p className="text-sm text-muted-foreground">Could not load this customer&apos;s traffic.</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No traffic through any server in the last 14 days.</p>
        ) : (
          <div className="rounded-lg border border-white/8 bg-card/40">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day (UTC)</TableHead>
                  <TableHead>Server</TableHead>
                  <TableHead>Protocol</TableHead>
                  <TableHead className="text-right">Up</TableHead>
                  <TableHead className="text-right">Down</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, index) => {
                  // The day is printed once per group; repeating it on
                  // every server's row makes the table read as more days
                  // than it is.
                  const firstOfDay = index === 0 || rows[index - 1].day !== row.day;
                  return (
                    <TableRow key={`${row.day}-${row.nodeName}-${row.protocol}`}>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {firstOfDay ? row.day : ""}
                      </TableCell>
                      <TableCell className="text-sm">{row.nodeName}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{protocolLabel(row.protocol)}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums">{megabytes(row.bytesUp)}</TableCell>
                      <TableCell className="text-right text-sm tabular-nums">{megabytes(row.bytesDown)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
