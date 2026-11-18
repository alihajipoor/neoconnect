import type { InsightServiceChecks } from "@/lib/types";
import { protocolLabel } from "@/lib/protocol-labels";
import { cn } from "@/lib/utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { serviceOutcome } from "./insight-labels";
import { lastRunRoute, msText, utcStamp } from "./diagnostics-format";
import { serviceOrder } from "./service-check-layout";
import { More, Muted, Ratio, Section, TableBox, When } from "./view-parts";

/** The customer's service checks: whether, through the server they were
 * on, a short fixed list of well-known services loaded, and how far each
 * got. The list is the server's (docs/client-diagnostics.md); the card
 * shows what the apps reported and names no cause. */
export function ServiceChecksCard({ checks, window }: { checks: InsightServiceChecks | undefined; window: string }) {
  if (!checks || checks.runs === 0) {
    return (
      <Section title="Service checks" note={`last ${window}`}>
        <Muted>
          No service check received in the last {window}. Apps will run one about once a day after connecting; this
          app version does not run it yet.
        </Muted>
      </Section>
    );
  }

  const latest = [...checks.latest].sort((a, b) => Number(a.ok) - Number(b.ok));
  const failed = latest.filter((r) => !r.ok).length;
  const route = lastRunRoute(checks);
  const order = serviceOrder(
    checks.latest.map((r) => ({ key: r.key, label: r.label ?? r.key })),
    checks.byServer.flatMap((s) => s.perService.map((p) => p.key)),
  );

  return (
    <Section
      title="Service checks"
      note={`last ${window}`}
      aside={
        <span className="text-muted-foreground tabular-nums">
          {checks.runs} {checks.runs === 1 ? "run" : "runs"}
        </span>
      }
    >
      {checks.lastRunAt && (
        <p className="text-sm">
          Last ran <When at={checks.lastRunAt} />
          <span className="text-muted-foreground"> ({utcStamp(checks.lastRunAt)})</span>
          {route && <span>, {route}</span>}
          {latest.length > 0 && (
            <span className={cn("ml-1", failed > 0 ? "text-red-300" : "text-muted-foreground")}>
              · {latest.length - failed} of {latest.length} reachable
            </span>
          )}
        </p>
      )}

      {latest.length === 0 ? (
        <Muted>The runs carried no results for the services on the list.</Muted>
      ) : (
        <>
        {/* On a phone, one compact line pair per service: nine stacked
            rows of five labelled facts each would be a wall. */}
        <ul className="flex flex-col divide-y divide-white/5 rounded-lg border border-white/8 bg-card/40 sm:hidden">
          {latest.map((r) => (
            <li key={r.key} className="px-3 py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-sm font-medium">{r.label ?? r.key}</span>
                <span className={cn("shrink-0 text-right text-sm", r.ok ? "text-success" : "text-red-300")}>
                  {serviceOutcome(r.ok, r.stage)}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground tabular-nums [overflow-wrap:anywhere]">
                {[
                  ["lookup", r.dnsMs],
                  ["handshake", r.tlsMs],
                  ["first byte", r.firstByteMs],
                ]
                  .filter(([, ms]) => ms !== null)
                  .map(([name, ms]) => `${name} ${msText(ms as number)}`)
                  .join(" · ") || "no times"}
                {r.status !== null && ` · HTTP ${r.status}`}
                {r.address && <span className="font-mono"> · {r.address}</span>}
                {" · "}
                <When at={r.at} />
              </p>
              {r.error && <p className="font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{r.error}</p>}
            </li>
          ))}
        </ul>
        <div className="max-sm:hidden">
        <TableBox>
          <Table stack>
            <TableHeader>
              <TableRow>
                <TableHead>Service</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="text-right">Name lookup</TableHead>
                <TableHead className="text-right">Secure handshake</TableHead>
                <TableHead className="text-right">First byte</TableHead>
                <TableHead>Resolved to</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {latest.map((r) => (
                <TableRow key={r.key}>
                  <TableCell cell="primary" className="text-sm">
                    {r.label ?? r.key}
                  </TableCell>
                  <TableCell cell="status" className="text-sm">
                    <span className={r.ok ? "text-success" : "text-red-300"}>{serviceOutcome(r.ok, r.stage)}</span>
                    {r.status !== null && <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">HTTP {r.status}</span>}
                    {r.error && (
                      <span className="block font-mono text-[11px] whitespace-normal text-muted-foreground [overflow-wrap:anywhere]">
                        {r.error}
                      </span>
                    )}
                  </TableCell>
                  <TableCell label="Name lookup" phoneOrder={1} className="text-right text-sm tabular-nums">
                    <Ms ms={r.dnsMs} />
                  </TableCell>
                  <TableCell label="Secure handshake" phoneOrder={2} className="text-right text-sm tabular-nums">
                    <Ms ms={r.tlsMs} />
                  </TableCell>
                  <TableCell label="First byte" phoneOrder={3} className="text-right text-sm tabular-nums">
                    <Ms ms={r.firstByteMs} />
                  </TableCell>
                  <TableCell label="Resolved to" phoneOrder={4} className="font-mono text-xs text-muted-foreground">
                    {r.address ?? "—"}
                  </TableCell>
                  <TableCell label="When" phoneOrder={5} className="text-sm">
                    <When at={r.at} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableBox>
        </div>
        </>
      )}

      {checks.byServer.length > 0 && (
        <More summary={`By server (${checks.byServer.length})`}>
          <TableBox>
            <Table stack>
              <TableHeader>
                <TableRow>
                  <TableHead>Server</TableHead>
                  <TableHead>Protocol</TableHead>
                  <TableHead className="text-right">Runs</TableHead>
                  {order.map((s) => (
                    <TableHead key={s.key} className="w-24 text-right leading-tight whitespace-normal">
                      {s.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {checks.byServer.map((row, index) => (
                  <TableRow key={`${row.server}-${row.protocol}-${index}`}>
                    <TableCell cell="primary" className="text-sm">
                      {row.server ?? (
                        <span className="text-muted-foreground">
                          {row.protocol ? "unknown server" : "Outside the VPN"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell label="Protocol" phoneOrder={1} className="text-sm text-muted-foreground">
                      {protocolLabel(row.protocol)}
                    </TableCell>
                    <TableCell label="Runs" phoneOrder={2} className="text-right text-sm tabular-nums">
                      {row.runs}
                    </TableCell>
                    {order.map((s) => {
                      const c = row.perService.find((p) => p.key === s.key);
                      return (
                        <TableCell key={s.key} label={s.label} phoneOrder={3} className="text-right text-sm">
                          {c ? <Ratio part={c.ok} whole={c.ok + c.failed} /> : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableBox>
          <p className="text-xs text-muted-foreground">Each cell counts reachable results of that service, of all its results.</p>
        </More>
      )}
    </Section>
  );
}

function Ms({ ms }: { ms: number | null }) {
  const text = msText(ms);
  return text ? <>{text}</> : <span className="text-muted-foreground">—</span>;
}
