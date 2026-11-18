import { apiFetch } from "@/lib/api";
import type { CustomerUsage, CustomerUsageHour, CustomerUsageSession } from "@/lib/types";
import { protocolLabel } from "@/lib/protocol-labels";
import { duration } from "@/lib/time";
import { formatBytes } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TrafficCard } from "./traffic-card";
import { HOUR_WINDOWS, customerHref } from "./insight-format";
import { hourColumns } from "./insight-layout";
import { ColumnChart, More, Muted, Section, StatTile, TableBox, Tiles, WindowSwitch, orNull } from "./view-parts";

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
          <UsageTiles usage={usage} windowLabel={windowLabel} />
          <HoursCard hours={usage.hours} windowHours={hours} windowLabel={windowLabel} />
          <SessionsCard usage={usage} windowLabel={windowLabel} />
        </>
      )}
      <TrafficCard traffic={usage?.days ?? null} days={30} title="Day by day" chart />
    </>
  );
}

/** The window's totals before any list. Up and down are the servers'
 * hourly counts; sessions and their time are the session list's, which
 * can miss its oldest when the window held too many records. */
function UsageTiles({ usage, windowLabel }: { usage: CustomerUsage; windowLabel: string }) {
  const up = usage.hours.reduce((sum, row) => sum + Number(row.bytesUp), 0);
  const down = usage.hours.reduce((sum, row) => sum + Number(row.bytesDown), 0);
  const seconds = usage.sessions.reduce((sum, s) => sum + s.seconds, 0);
  const capped = usage.sessionsCapped ? "oldest sessions missing" : undefined;
  return (
    <Tiles>
      <StatTile label="Downloaded" value={formatBytes(down)} sub={`last ${windowLabel}`} />
      <StatTile label="Uploaded" value={formatBytes(up)} sub={`last ${windowLabel}`} />
      <StatTile label="Sessions" value={usage.sessions.length} sub={capped ?? `last ${windowLabel}`} />
      <StatTile label="Time with traffic" value={duration(seconds)} sub={capped ?? "the sessions added up"} />
    </Tiles>
  );
}

const SESSIONS_SHOWN = 5;

function SessionsCard({ usage, windowLabel }: { usage: CustomerUsage; windowLabel: string }) {
  const first = usage.sessions.slice(0, SESSIONS_SHOWN);
  const rest = usage.sessions.slice(SESSIONS_SHOWN);
  return (
    <Section title="Sessions" note={`last ${windowLabel}`}>
      <p className="text-xs text-muted-foreground">
        A session is traffic on one server and protocol with no gap longer than 15 minutes.
        {usage.sessionsCapped && " The window held more traffic records than are read, so its oldest sessions are missing."}
      </p>
      {usage.sessions.length === 0 ? (
        <Muted>No traffic through any server in the last {windowLabel}.</Muted>
      ) : (
        <>
          <SessionTable sessions={first} />
          {rest.length > 0 && (
            <More summary={`Show ${rest.length} older ${rest.length === 1 ? "session" : "sessions"}`}>
              <SessionTable sessions={rest} />
            </More>
          )}
        </>
      )}
    </Section>
  );
}

function SessionTable({ sessions }: { sessions: CustomerUsageSession[] }) {
  return (
    <TableBox>
      <Table stack>
        <TableHeader>
          <TableRow>
            <TableHead>Start</TableHead>
            <TableHead>End</TableHead>
            <TableHead className="text-right">Length</TableHead>
            <TableHead>Server</TableHead>
            <TableHead>Protocol</TableHead>
            <TableHead className="text-right">Up</TableHead>
            <TableHead className="text-right">Down</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((s) => (
            <TableRow key={`${s.start}-${s.nodeName}-${s.protocol}`}>
              <TableCell cell="primary" className="text-sm whitespace-nowrap">
                {new Date(s.start).toLocaleString()}
              </TableCell>
              <TableCell label="End" phoneOrder={1} className="text-sm whitespace-nowrap text-muted-foreground">
                {new Date(s.end).toLocaleString()}
              </TableCell>
              <TableCell label="Length" phoneOrder={2} className="text-right text-sm tabular-nums">
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
  );
}

interface HourGroup {
  hour: string;
  total: number;
  rows: CustomerUsageHour[];
}

/** The window as a column chart first; the hours with traffic, newest
 * first and each with its servers, folded under it. */
function HoursCard({
  hours,
  windowHours,
  windowLabel,
}: {
  hours: CustomerUsageHour[];
  windowHours: number;
  windowLabel: string;
}) {
  const groups = new Map<string, HourGroup>();
  for (const row of hours) {
    const group = groups.get(row.hour) ?? { hour: row.hour, total: 0, rows: [] };
    group.total += Number(row.bytesUp) + Number(row.bytesDown);
    group.rows.push(row);
    groups.set(row.hour, group);
  }
  const list = [...groups.values()].sort((a, b) => b.hour.localeCompare(a.hour));
  const max = Math.max(1, ...list.map((g) => g.total));
  // Empty hours included, up to the hour the data was read in.
  const columns = hourColumns(hours, windowHours);
  const peak = Math.max(0, ...columns.map((c) => c.up + c.down));

  return (
    <Section title="Hour by hour" note={`UTC, last ${windowLabel}`}>
      {list.length === 0 ? (
        <Muted>No traffic in any hour of the last {windowLabel}.</Muted>
      ) : (
        <>
          <ColumnChart
            caption={`Traffic per ${columns[0].hours === 1 ? "hour" : `${columns[0].hours} hours`}, last ${windowLabel}, UTC`}
            peak={formatBytes(peak)}
            start={utcHour(columns[0].start)}
            end="now"
            columns={columns.map((c) => ({
              key: c.start,
              value: c.up + c.down,
              label: `${utcHour(c.start)}${
                c.hours > 1 ? `–${utcHour(new Date(Date.parse(c.start) + c.hours * 3_600_000).toISOString()).slice(11)}` : ""
              } UTC: ${formatBytes(c.down)} down, ${formatBytes(c.up)} up`,
            }))}
          />
          <More summary={`Show the ${list.length} ${list.length === 1 ? "hour" : "hours"} with traffic`}>
            <ul className="flex flex-col divide-y divide-white/5 rounded-lg border border-white/8 bg-card/40">
              {list.map((group) => (
                <li key={group.hour} className="flex flex-wrap items-start gap-x-4 gap-y-1 px-3 py-2">
                  <span className="w-28 shrink-0 font-mono text-xs text-muted-foreground">{utcHour(group.hour)}</span>
                  <div className="flex min-w-40 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/8">
                        <div
                          className="h-full rounded-full bg-primary/70"
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
          </More>
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
