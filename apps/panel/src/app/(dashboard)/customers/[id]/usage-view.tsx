import { apiFetch } from "@/lib/api";
import type { CustomerUsage, CustomerUsageHour } from "@/lib/types";
import { protocolLabel } from "@/lib/protocol-labels";
import { duration } from "@/lib/time";
import { formatBytes } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TrafficCard } from "./traffic-card";
import { HOUR_WINDOWS, customerHref } from "./insight-format";
import { Muted, Section, TableBox, WindowSwitch, orNull } from "./view-parts";

/** What the servers counted for this customer: sessions, hour by hour
 * and day by day. Traffic, not the apps' claims. */
export async function UsageView({ customerId, hours }: { customerId: string; hours: number }) {
  const usage = await orNull(
    apiFetch<CustomerUsage>(`/customers/${encodeURIComponent(customerId)}/usage?hours=${hours}`),
  );
  const windowLabel = HOUR_WINDOWS.find((w) => w.value === hours)?.label ?? `${hours} hours`;

  return (
    <>
      <WindowSwitch
        label="Traffic from the last"
        options={HOUR_WINDOWS}
        current={hours}
        href={(value) => customerHref(customerId, { view: "usage", hours: value })}
      />
      {usage === null ? (
        <Section title="Sessions">
          <Muted>Could not load this customer&apos;s usage.</Muted>
        </Section>
      ) : (
        <>
          <SessionsCard usage={usage} windowLabel={windowLabel} />
          <HoursCard hours={usage.hours} windowLabel={windowLabel} />
        </>
      )}
      <TrafficCard traffic={usage?.days ?? null} days={30} title="Day by day" />
    </>
  );
}

function SessionsCard({ usage, windowLabel }: { usage: CustomerUsage; windowLabel: string }) {
  return (
    <Section title="Sessions" note={`last ${windowLabel}`}>
      <p className="text-xs text-muted-foreground">
        A session is traffic on one server and protocol with no gap longer than 15 minutes.
        {usage.sessionsCapped && " The window held more traffic records than are read, so its oldest sessions are missing."}
      </p>
      {usage.sessions.length === 0 ? (
        <Muted>No traffic through any server in the last {windowLabel}.</Muted>
      ) : (
        <TableBox>
          <Table stack>
            <TableHeader>
              <TableRow>
                <TableHead>Start</TableHead>
                <TableHead>End</TableHead>
                <TableHead>Length</TableHead>
                <TableHead>Server</TableHead>
                <TableHead>Protocol</TableHead>
                <TableHead className="text-right">Up</TableHead>
                <TableHead className="text-right">Down</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.sessions.map((s) => (
                <TableRow key={`${s.start}-${s.nodeName}-${s.protocol}`}>
                  <TableCell cell="primary" className="text-sm whitespace-nowrap">
                    {new Date(s.start).toLocaleString()}
                  </TableCell>
                  <TableCell label="End" phoneOrder={1} className="text-sm whitespace-nowrap text-muted-foreground">
                    {new Date(s.end).toLocaleString()}
                  </TableCell>
                  <TableCell label="Length" phoneOrder={2} className="text-sm tabular-nums">
                    {duration(s.seconds)}
                  </TableCell>
                  <TableCell label="Server" phoneOrder={3} className="text-sm">
                    {s.nodeName}
                  </TableCell>
                  <TableCell label="Protocol" phoneOrder={4} className="text-sm text-muted-foreground">
                    {protocolLabel(s.protocol)}
                  </TableCell>
                  <TableCell label="Up" phoneOrder={5} className="text-right text-sm tabular-nums">
                    {formatBytes(s.bytesUp)}
                  </TableCell>
                  <TableCell label="Down" phoneOrder={6} className="text-right text-sm tabular-nums">
                    {formatBytes(s.bytesDown)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableBox>
      )}
    </Section>
  );
}

interface HourGroup {
  hour: string;
  total: number;
  rows: CustomerUsageHour[];
}

/** Hours with traffic, newest first, each with its servers. The bar is
 * the hour's total against the busiest hour in the window. */
function HoursCard({ hours, windowLabel }: { hours: CustomerUsageHour[]; windowLabel: string }) {
  const groups = new Map<string, HourGroup>();
  for (const row of hours) {
    const group = groups.get(row.hour) ?? { hour: row.hour, total: 0, rows: [] };
    group.total += Number(row.bytesUp) + Number(row.bytesDown);
    group.rows.push(row);
    groups.set(row.hour, group);
  }
  const list = [...groups.values()].sort((a, b) => b.hour.localeCompare(a.hour));
  const max = Math.max(1, ...list.map((g) => g.total));

  return (
    <Section title="Hour by hour" note={`UTC, last ${windowLabel}`}>
      {list.length === 0 ? (
        <Muted>No traffic in any hour of the last {windowLabel}.</Muted>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">Only hours with traffic are listed.</p>
          <ul className="flex flex-col divide-y divide-white/5 rounded-lg border border-white/8 bg-card/40">
            {list.map((group) => (
              <li key={group.hour} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-3 py-2">
                <span className="w-28 shrink-0 font-mono text-xs text-muted-foreground" title={group.hour}>
                  {utcHour(group.hour)}
                </span>
                <div className="flex min-w-40 flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/8">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.max((group.total / max) * 100, 1)}%` }}
                      />
                    </div>
                    <span className="w-20 shrink-0 text-right text-xs tabular-nums">{formatBytes(group.total)}</span>
                  </div>
                  <ul className="flex flex-col gap-0.5">
                    {group.rows.map((row) => (
                      <li
                        key={`${row.nodeName}-${row.protocol}`}
                        className="flex flex-wrap gap-x-2 text-xs text-muted-foreground"
                      >
                        <span className="text-foreground/90">{row.nodeName}</span>
                        <span>{protocolLabel(row.protocol)}</span>
                        <span className="tabular-nums">
                          {formatBytes(row.bytesUp)} up, {formatBytes(row.bytesDown)} down
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

/** "2026-11-18 14:00" from the hour's ISO start. */
function utcHour(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}
