import { apiFetch } from "@/lib/api";
import { requireStaff } from "@/lib/session";
import type { ServiceChecksSummary } from "@/lib/types";
import { protocolLabel } from "@/lib/protocol-labels";
import { cn } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { stageLabel } from "../customers/[id]/insight-labels";
import { msText } from "../customers/[id]/diagnostics-format";
import {
  CHECK_WINDOWS,
  cellTone,
  parseCheckHours,
  failStageShort,
  failStageText,
  percentText,
  reachableTotals,
  serviceChecksHref,
  serviceOrder,
  type ServiceColumn,
} from "../customers/[id]/service-check-layout";
import { More, Muted, NetworkLabel, Section, ShareBar, StatTile, TableBox, Tiles, WindowSwitch, orNull } from "../customers/[id]/view-parts";

/** The apps' service checks across every customer: through each server,
 * did the fixed list of well-known services load, and how fast. The list
 * is the server's (docs/client-diagnostics.md). Per server only runs made
 * through the VPN count; per network, every run. Counts of what the apps
 * reported; no cause is named. */
export default async function ServiceChecksPage({
  searchParams,
}: {
  searchParams: Promise<{ hours?: string }>;
}) {
  await requireStaff();
  const hours = parseCheckHours((await searchParams).hours);
  const summary = await orNull(apiFetch<ServiceChecksSummary>(`/service-checks/summary?hours=${hours}`));
  const window = CHECK_WINDOWS.find((w) => w.value === hours)?.label ?? `${hours} hours`;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Service checks</h1>
        <p className="text-sm text-muted-foreground">
          Whether well-known services load through each server, as the apps tested them.
        </p>
      </div>

      <WindowSwitch label="Runs from the last" options={CHECK_WINDOWS} current={hours} href={serviceChecksHref} />

      {summary === null ? (
        <Section title="Service checks">
          <Muted>Could not load the service-check summary.</Muted>
        </Section>
      ) : summary.runs === 0 ? (
        <Section title="Service checks">
          <Muted>
            No app has sent a service check in the last {window}. Apps will run one about once a day after connecting;
            the current app versions do not run it yet.
          </Muted>
        </Section>
      ) : (
        <Summary summary={summary} window={window} />
      )}
    </div>
  );
}

function Summary({ summary, window }: { summary: ServiceChecksSummary; window: string }) {
  const columns = serviceOrder(
    summary.targets.map((t) => ({ key: t.key, label: t.label })),
    [...summary.byServer, ...summary.byNetwork].flatMap((r) => r.perService.map((p) => p.key)),
  );
  const totals = reachableTotals(summary.byServer);
  const tunnelRuns = summary.byServer.reduce((sum, s) => sum + s.runs, 0);

  return (
    <>
      <Tiles>
        <StatTile label="Runs" value={summary.runs.toLocaleString()} sub={`last ${window}; ${tunnelRuns.toLocaleString()} through the VPN`} />
        <StatTile label="Customers" value={summary.customers.toLocaleString()} sub="whose apps sent one" />
        <StatTile label="Services checked" value={summary.targets.length} sub="on the server's fixed list" />
        <StatTile
          label="Reachable"
          value={
            totals.total === 0 ? (
              "—"
            ) : (
              <>
                {totals.ok.toLocaleString()} of {totals.total.toLocaleString()}
                <span className="ml-1.5 text-sm font-normal text-muted-foreground">{percentText(totals.ok, totals.total)}</span>
              </>
            )
          }
          bar={totals.total > 0 ? { part: totals.ok, whole: totals.total } : undefined}
          sub="of all results through the VPN"
          tone={cellTone(totals.ok, totals.total - totals.ok) === "problem" ? "problem" : "neutral"}
        />
      </Tiles>

      <Section title="By server" note="runs through the VPN only">
        {summary.byServer.length === 0 ? (
          <Muted>No run in the last {window} said it went through the VPN.</Muted>
        ) : (
          <Matrix
            columns={columns}
            rows={summary.byServer.map((s, index) => ({
              key: `${s.server}-${s.protocol}-${index}`,
              title: s.server ?? "unknown server",
              sub: protocolLabel(s.protocol),
              runs: s.runs,
              customers: s.customers,
              cells: s.perService,
            }))}
            firstHead="Server"
          />
        )}
        <Legend />
      </Section>

      <Section title="By network" note={`the ${Math.min(15, summary.byNetwork.length)} with the most runs, inside or outside the VPN`}>
        {summary.byNetwork.length === 0 ? (
          <Muted>No run named its network.</Muted>
        ) : (
          <Matrix
            columns={columns}
            rows={summary.byNetwork.map((n) => ({
              key: String(n.asn),
              title: <NetworkLabel network={{ asn: n.asn, name: n.name }} />,
              sub: n.country ?? undefined,
              runs: n.runs,
              customers: n.customers,
              cells: n.perService,
            }))}
            firstHead="Network"
          />
        )}
      </Section>
    </>
  );
}

interface MatrixCell {
  key: string;
  ok: number;
  failed: number;
  medianFirstByteMs?: number | null;
  topFailStage?: string | null;
}

interface MatrixRow {
  key: string;
  title: React.ReactNode;
  sub?: string;
  runs: number;
  customers: number;
  cells: MatrixCell[];
}

/** The first column stays in view when the services scroll sideways (only
 * if the list ever outgrows the card); opaque, so cells pass under it. */
const PINNED = "sticky left-0 z-[1] bg-card shadow-[inset_-1px_0_0_var(--border)]";

/** Rows by services: a compact table from 640px that fits the content
 * column at 1024px with nine services, and one card per row on a phone
 * with the services listed in it. */
function Matrix({ columns, rows, firstHead }: { columns: ServiceColumn[]; rows: MatrixRow[]; firstHead: string }) {
  return (
    <>
      <div className="max-sm:hidden">
        <TableBox>
          <Table stickyFirst className="[&_td]:px-1.5 [&_td]:py-2 [&_th]:px-1.5">
            <TableHeader>
              <TableRow>
                <TableHead className={cn(PINNED, "pl-3!")}>{firstHead}</TableHead>
                <TableHead className="text-right text-xs">Runs</TableHead>
                {columns.map((c) => (
                  <TableHead
                    key={c.key}
                    className="h-auto py-2 text-right align-bottom text-xs leading-tight whitespace-normal [overflow-wrap:anywhere]"
                  >
                    {c.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell className={cn(PINNED, "min-w-32 max-w-40 pl-3! text-sm whitespace-normal break-words")}>
                    <span className="block">{row.title}</span>
                    {row.sub && <span className="block text-xs text-muted-foreground">{row.sub}</span>}
                  </TableCell>
                  <TableCell className="text-right text-sm tabular-nums">
                    {row.runs}
                    <span className="block text-[11px] text-muted-foreground">
                      {row.customers} {row.customers === 1 ? "customer" : "customers"}
                    </span>
                  </TableCell>
                  {columns.map((c) => (
                    <TableCell key={c.key} className="align-top text-right">
                      <Cell cell={row.cells.find((x) => x.key === c.key)} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableBox>
      </div>

      <ul className="flex flex-col gap-3 sm:hidden">
        {rows.map((row) => (
          <li key={row.key} className="rounded-lg border border-white/8 bg-card/40 px-3.5 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <p className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">{row.title}</p>
              <p className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {row.runs} {row.runs === 1 ? "run" : "runs"}, {row.customers} {row.customers === 1 ? "customer" : "customers"}
              </p>
            </div>
            {row.sub && <p className="text-xs text-muted-foreground">{row.sub}</p>}
            <PhoneCells columns={columns} cells={row.cells} />
          </li>
        ))}
      </ul>
    </>
  );
}

/** A phone card's services: those with failures listed, answer first;
 * the ones where every result was reachable folded under one line. */
function PhoneCells({ columns, cells }: { columns: ServiceColumn[]; cells: MatrixCell[] }) {
  const present = columns
    .map((c) => ({ column: c, cell: cells.find((x) => x.key === c.key) }))
    .filter((x): x is { column: ServiceColumn; cell: MatrixCell } => !!x.cell && x.cell.ok + x.cell.failed > 0);
  const failing = present.filter((x) => x.cell.failed > 0);
  const clean = present.filter((x) => x.cell.failed === 0);
  const line = ({ column, cell }: { column: ServiceColumn; cell: MatrixCell }) => (
    <li key={column.key} className="flex items-start justify-between gap-3 py-1.5">
      <span className="min-w-0 text-sm">{column.label}</span>
      <span className="shrink-0 text-right">
        <Cell cell={cell} wide />
      </span>
    </li>
  );
  return (
    <div className="mt-1.5">
      {failing.length > 0 && <ul className="flex flex-col divide-y divide-white/5">{failing.map(line)}</ul>}
      {clean.length > 0 && (
        <More summary={`${clean.length} ${clean.length === 1 ? "service" : "services"} all reachable`}>
          <ul className="-mt-2 flex flex-col divide-y divide-white/5">{clean.map(line)}</ul>
        </More>
      )}
    </div>
  );
}

/** "12 of 14" with a bar, the median time to the first byte under it
 * (the caption says what the time is), and where most failures stopped:
 * short in the table, in full on a phone card. Quiet red under half
 * reachable over 3+ results. */
function Cell({ cell, wide }: { cell: MatrixCell | undefined; wide?: boolean }) {
  if (!cell || cell.ok + cell.failed === 0) return <span className="text-sm text-muted-foreground">—</span>;
  const total = cell.ok + cell.failed;
  const tone = cellTone(cell.ok, cell.failed);
  const firstByte = msText(cell.medianFirstByteMs);
  return (
    <span className={cn("inline-flex flex-col items-end gap-1 align-top", wide ? "w-40" : "w-16")}>
      <span className={cn("tabular-nums", wide ? "text-sm" : "text-xs", tone === "problem" && "text-red-300")}>
        {cell.ok} of {total}
      </span>
      <ShareBar part={cell.ok} whole={total} />
      {firstByte && (
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {firstByte}
          {wide && " first byte"}
        </span>
      )}
      {cell.failed > 0 && cell.topFailStage && (
        <span className={cn("text-[11px] leading-tight whitespace-normal", tone === "problem" ? "text-red-300" : "text-muted-foreground")}>
          {wide
            ? failStageText(cell.failed, stageLabel(cell.topFailStage))
            : failStageShort(stageLabel(cell.topFailStage))}
        </span>
      )}
    </span>
  );
}

function Legend() {
  return (
    <p className="text-xs text-muted-foreground">
      Each cell: results that were reachable, of all results for that service; under it, the median time until the
      first byte of the reply, and where most failures stopped. Red when under half were reachable over at least three
      results.
    </p>
  );
}
