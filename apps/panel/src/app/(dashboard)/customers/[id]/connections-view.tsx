import Link from "next/link";
import { SlidersHorizontal, X } from "lucide-react";
import { apiFetch, apiFetchList } from "@/lib/api";
import type { CustomerAttemptDetail, CustomerInsight } from "@/lib/types";
import { KINDS, OUTCOMES } from "@/lib/attempt-labels";
import { protocolLabel } from "@/lib/protocol-labels";
import { cn } from "@/lib/utils";
import { Pager } from "@/components/dashboard/pager";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AttemptTable } from "./connection-log";
import { CATEGORY_LABELS, FAILURE_LABELS, categoryLabel, failureLabel } from "./insight-labels";
import {
  DAY_WINDOWS,
  FILTER_KEYS,
  attemptsQuery,
  customerHref,
  hasFilters,
  othersLine,
  speedText,
  type AttemptFilters,
} from "./insight-format";
import { percent, topFailure } from "./insight-layout";
import { windowText } from "./overview-view";
import {
  FoldedText,
  Muted,
  NetworkLabel,
  Ratio,
  Section,
  StatTile,
  TableBox,
  Tiles,
  When,
  WindowSwitch,
  orNull,
} from "./view-parts";

/** Where this customer's connections go wrong: by network, by server and
 * connection type, by failure cause, and then every report. */
export async function ConnectionsView({
  customerId,
  days,
  filters,
  take,
  skip,
}: {
  customerId: string;
  days: number;
  filters: AttemptFilters;
  take: number;
  skip: number;
}) {
  const id = encodeURIComponent(customerId);
  const [insight, attempts] = await Promise.all([
    orNull(apiFetch<CustomerInsight>(`/customers/${id}/insight?days=${days}`)),
    orNull(apiFetchList<CustomerAttemptDetail>(`/customers/${id}/attempts?${attemptsQuery(filters, take, skip)}`)),
  ]);

  const base = { view: "connections", days };

  return (
    <>
      <WindowSwitch
        label="Reports from the last"
        options={DAY_WINDOWS}
        current={days}
        href={(value) => customerHref(customerId, { ...base, ...filters, days: value })}
      />

      {insight === null ? (
        <Section title="By network">
          <Muted>Could not load this customer&apos;s reports.</Muted>
        </Section>
      ) : (
        <>
          <ConnectionTiles insight={insight} customerId={customerId} days={days} />
          <NetworksCard insight={insight} customerId={customerId} days={days} />
          <RoutesCard insight={insight} days={days} />
          <FailuresCard insight={insight} customerId={customerId} days={days} />
        </>
      )}

      <Section
        title="Full log"
        note={attempts && attempts.total > 0 ? `${attempts.total.toLocaleString()} reports, newest first, not limited to the window above` : undefined}
      >
        <FilterBar customerId={customerId} days={days} filters={filters} insight={insight} />
        {attempts === null ? (
          <Muted>Could not load this customer&apos;s reports.</Muted>
        ) : attempts.items.length === 0 ? (
          <Muted>
            {hasFilters(filters)
              ? "No reports match these filters."
              : "No reports from this customer's apps. A report needs the app to reach us at some point, so attempts that all failed before signing in appear only on the Client Attempts page, without a name."}
          </Muted>
        ) : (
          <AttemptTable attempts={attempts.items} />
        )}
        {attempts && (
          <Pager
            total={attempts.total}
            take={take}
            skip={skip}
            basePath={`/customers/${customerId}`}
            params={{ view: "connections", days: days === 7 ? undefined : String(days), ...filters }}
          />
        )}
      </Section>
    </>
  );
}

/** The answer before the tables: how many tries worked, how often the app
 * could not reach us, and the cause reported most. */
function ConnectionTiles({ insight, customerId, days }: { insight: CustomerInsight; customerId: string; days: number }) {
  const { tried, succeeded } = insight.connect;
  const share = percent(succeeded, tried);
  // The same sum the backend's API_UNREACHABLE_OFTEN finding and the
  // network table's column are counted from.
  const apiUnreachable = insight.networks.reduce((sum, n) => sum + n.apiUnreachable, 0);
  const top = topFailure(insight.failures);
  const window = windowText(days);
  return (
    <Tiles>
      <StatTile label="Attempts" value={tried} sub={`connects and reconnect passes, last ${window}`} />
      <StatTile
        label="Succeeded"
        value={
          tried === 0 ? (
            "—"
          ) : (
            <>
              {succeeded} of {tried}
              <span className="ml-1.5 text-sm font-normal text-muted-foreground">{share}%</span>
            </>
          )
        }
        tone={tried > 0 && succeeded === 0 ? "problem" : "neutral"}
        bar={tried > 0 ? { part: succeeded, whole: tried } : undefined}
        sub={tried === 0 ? `no attempts in the last ${window}` : undefined}
      />
      <StatTile
        label="Could not reach our API"
        value={apiUnreachable}
        sub="background reports"
        tone={apiUnreachable > 0 ? "warning" : "neutral"}
      />
      <StatTile
        label="Most common cause"
        value={
          top ? (
            <Link
              href={customerHref(customerId, { view: "connections", days, failureCode: top.failure.code })}
              className="text-sm font-medium underline-offset-2 hover:underline"
            >
              {failureLabel(top.failure.code)}
            </Link>
          ) : (
            <span className="text-sm font-normal text-muted-foreground">No failures reported</span>
          )
        }
        sub={
          top
            ? `${top.failure.count} ${top.failure.count === 1 ? "time" : "times"}${
                top.tiedWith > 0 ? `, tied with ${top.tiedWith} other ${top.tiedWith === 1 ? "cause" : "causes"}` : ""
              }`
            : undefined
        }
      />
    </Tiles>
  );
}

function NetworksCard({ insight, customerId, days }: { insight: CustomerInsight; customerId: string; days: number }) {
  const known = insight.networks.filter((n) => n.asn !== null).length;
  return (
    <Section title="By network" note={`last ${windowText(days)}`}>
      {insight.networks.length === 0 ? (
        <Muted>No reports in the last {windowText(days)}.</Muted>
      ) : (
        <>
          <TableBox>
            <Table stack>
              <TableHeader>
                <TableRow>
                  <TableHead>Network</TableHead>
                  <TableHead>Country</TableHead>
                  <TableHead className="w-24 text-right leading-tight whitespace-normal">Succeeded of tried</TableHead>
                  <TableHead className="text-right">API not reached</TableHead>
                  <TableHead>Last success</TableHead>
                  <TableHead>Other customers here (48 h)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {insight.networks.map((n) => (
                  <TableRow key={n.asn ?? "none"}>
                    <TableCell cell="primary" className="text-sm whitespace-normal">
                      {n.asn === null ? (
                        <span className="text-muted-foreground">No network in the report</span>
                      ) : (
                        <Link
                          href={customerHref(customerId, { view: "connections", days, asn: n.asn })}
                          className="hover:underline"
                          title="Show this network's reports in the log below"
                        >
                          <NetworkLabel network={{ asn: n.asn, name: n.name }} />
                        </Link>
                      )}
                    </TableCell>
                    <TableCell label="Country" phoneOrder={1} className="text-sm">
                      {n.country ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell label="Succeeded of tried" phoneOrder={2} className="text-right text-sm">
                      <Ratio part={n.succeeded} whole={n.tried} />
                    </TableCell>
                    <TableCell label="API not reached" phoneOrder={3} className="text-right text-sm tabular-nums">
                      {n.apiUnreachable}
                    </TableCell>
                    <TableCell label="Last success" phoneOrder={5} className="text-sm">
                      <When at={n.lastSuccessAt} empty="none" />
                    </TableCell>
                    <TableCell label="Others (48 h)" wide phoneOrder={6} className="text-sm">
                      {n.asn === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className={n.others ? undefined : "text-muted-foreground"}>
                          {othersLine(n.others, known)}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableBox>
          <p className="text-xs text-muted-foreground">
            Tried counts connects and automatic reconnect passes. &ldquo;API not reached&rdquo; counts background
            reports where the app could not reach our API. Other customers are compared only when at least three
            tried the same network.
          </p>
        </>
      )}
    </Section>
  );
}

function RoutesCard({ insight, days }: { insight: CustomerInsight; days: number }) {
  return (
    <Section title="By server and connection type" note={`last ${windowText(days)}`}>
      {insight.routes.length === 0 ? (
        <Muted>No server was dialled in the last {windowText(days)}.</Muted>
      ) : (
        <TableBox>
          <Table stack>
            <TableHeader>
              <TableRow>
                <TableHead>Server</TableHead>
                <TableHead>Protocol</TableHead>
                <TableHead className="text-right">Dialled</TableHead>
                <TableHead className="w-24 text-right leading-tight whitespace-normal">Connected of dialled</TableHead>
                <TableHead className="w-24 text-right leading-tight whitespace-normal">Carried of connected</TableHead>
                <TableHead>Typical speed</TableHead>
                <TableHead>Last result</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {insight.routes.map((r, index) => {
                const speed = speedText(r.medianDownKbps, r.medianUpKbps);
                return (
                  <TableRow key={`${r.server}-${r.protocol}-${index}`}>
                    <TableCell cell="primary" className="text-sm">
                      {r.server ?? <span className="text-muted-foreground">unknown server</span>}
                    </TableCell>
                    <TableCell label="Protocol" phoneOrder={1} className="text-sm text-muted-foreground">
                      {protocolLabel(r.protocol)}
                    </TableCell>
                    <TableCell label="Dialled" phoneOrder={2} className="text-right text-sm tabular-nums">
                      {r.dialled}
                      {/* Said in words, not only on hover: a touch screen
                          never shows a title. */}
                      {r.notDialled > 0 && (
                        <span className="block text-[11px] text-muted-foreground">
                          not dialled {r.notDialled} {r.notDialled === 1 ? "time" : "times"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell label="Connected of dialled" phoneOrder={3} className="text-right text-sm">
                      <Ratio part={r.connected} whole={r.dialled} />
                    </TableCell>
                    <TableCell label="Carried of connected" phoneOrder={4} className="text-right text-sm">
                      <Ratio part={r.carried} whole={r.connected} />
                    </TableCell>
                    <TableCell label="Typical speed" phoneOrder={5} className="text-sm whitespace-normal">
                      {speed ?? <span className="text-muted-foreground">not measured</span>}
                    </TableCell>
                    <TableCell
                      label="Last result"
                      wide
                      phoneOrder={6}
                      // A table cell ignores max-width, so the cap alone let
                      // the text widen the table past its card. Full width
                      // with a zero max-width makes this column take what
                      // the others leave and shorten to it (from 640px; a
                      // phone stacks the row).
                      className="text-xs text-muted-foreground sm:w-full sm:max-w-0"
                    >
                      <FoldedText text={r.lastResult} />
                    </TableCell>
                    <TableCell label="When" phoneOrder={7} className="text-sm">
                      <When at={r.lastAt} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableBox>
      )}
    </Section>
  );
}

function FailuresCard({ insight, customerId, days }: { insight: CustomerInsight; customerId: string; days: number }) {
  return (
    <Section title="Why it failed" note={`last ${windowText(days)}, as the apps reported it`}>
      {insight.failures.length === 0 ? (
        <Muted>No failures reported in the last {windowText(days)}.</Muted>
      ) : (
        <TableBox>
          <Table stack>
            <TableHeader>
              <TableRow>
                <TableHead>What the app reported</TableHead>
                <TableHead className="text-right">Count</TableHead>
                <TableHead>Last time</TableHead>
                <TableHead>Example</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {insight.failures.map((f) => (
                <TableRow key={f.code}>
                  <TableCell cell="primary" className="text-sm whitespace-normal sm:min-w-56">
                    <Link
                      href={customerHref(customerId, { view: "connections", days, failureCode: f.code })}
                      className="hover:underline"
                      title="Show these reports in the log below"
                    >
                      {failureLabel(f.code)}
                    </Link>
                  </TableCell>
                  <TableCell label="Count" phoneOrder={1} className="text-right text-sm tabular-nums">
                    {f.count}
                  </TableCell>
                  <TableCell label="Last time" phoneOrder={2} className="text-sm">
                    <When at={f.lastAt} />
                  </TableCell>
                  <TableCell
                    label="Example"
                    wide
                    phoneOrder={3}
                    className="font-mono text-xs text-muted-foreground sm:w-full sm:max-w-0"
                  >
                    <FoldedText text={f.example} />
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

const selectClass =
  "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50 max-lg:h-10 md:w-auto md:max-w-48";

/** The log's filters as a plain GET form, so it works without client
 * JavaScript. The view and window ride along as hidden fields. */
function FilterBar({
  customerId,
  days,
  filters,
  insight,
}: {
  customerId: string;
  days: number;
  filters: AttemptFilters;
  insight: CustomerInsight | null;
}) {
  const platforms = new Set((insight?.apps ?? []).map((a) => a.platform));
  if (filters.platform) platforms.add(filters.platform);
  const networks = (insight?.networks ?? []).filter((n) => n.asn !== null);
  if (filters.asn && !networks.some((n) => String(n.asn) === filters.asn)) {
    networks.push({
      asn: Number(filters.asn),
      name: null,
      country: null,
      tried: 0,
      succeeded: 0,
      apiUnreachable: 0,
      lastAt: null,
      lastSuccessAt: null,
      others: null,
    });
  }

  const chipText: Record<keyof AttemptFilters, (value: string) => string> = {
    kind: (v) => `Kind: ${KINDS[v as keyof typeof KINDS] ?? v}`,
    outcome: (v) => `Outcome: ${OUTCOMES[v as keyof typeof OUTCOMES]?.label ?? v}`,
    category: (v) => `Type: ${categoryLabel(v)}`,
    failureCode: (v) => `Cause: ${failureLabel(v)}`,
    platform: (v) => `Platform: ${v}`,
    asn: (v) => {
      const name = networks.find((n) => String(n.asn) === v)?.name;
      return `Network: ${name ? `${name} (AS${v})` : `AS${v}`}`;
    },
    q: (v) => `Words: “${v}”`,
  };
  const active = FILTER_KEYS.filter((key) => filters[key] !== undefined);

  // On a phone the controls fold behind "Filters" (a checkbox, so no
  // script), and what is set shows as chips that each remove themselves.
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input id="log-filters-toggle" type="checkbox" className="peer sr-only" />
      <label
        htmlFor="log-filters-toggle"
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          "cursor-pointer select-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring/50 md:hidden",
        )}
      >
        <SlidersHorizontal />
        Filters{active.length > 0 && ` (${active.length})`}
      </label>
      {active.map((key) => (
        <Link
          key={key}
          href={customerHref(customerId, { view: "connections", days, ...filters, [key]: undefined })}
          className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full border border-white/10 bg-white/5 py-1 pr-2 pl-3 text-xs transition-colors hover:bg-white/10 max-md:min-h-10"
          aria-label={`Remove filter ${chipText[key](filters[key] as string)}`}
        >
          <span className="truncate">{chipText[key](filters[key] as string)}</span>
          <X className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Link>
      ))}
      {active.length > 0 && (
        <Link
          href={customerHref(customerId, { view: "connections", days })}
          className="inline-flex min-h-8 items-center px-1 text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline max-md:min-h-10"
        >
          Clear all
        </Link>
      )}
      <form
        method="get"
        action={`/customers/${customerId}`}
        className="hidden basis-full grid-cols-1 gap-2 peer-checked:grid sm:grid-cols-2 md:flex md:flex-wrap md:items-end md:peer-checked:flex"
      >
      <input type="hidden" name="view" value="connections" />
      {days !== 7 && <input type="hidden" name="days" value={days} />}
      <FilterSelect name="kind" label="Kind" value={filters.kind} options={Object.entries(KINDS)} />
      <FilterSelect
        name="outcome"
        label="Outcome"
        value={filters.outcome}
        options={Object.entries(OUTCOMES).map(([k, v]) => [k, v.label])}
      />
      <FilterSelect name="category" label="Type" value={filters.category} options={Object.entries(CATEGORY_LABELS)} />
      <FilterSelect name="failureCode" label="Cause" value={filters.failureCode} options={Object.entries(FAILURE_LABELS)} />
      <FilterSelect name="platform" label="Platform" value={filters.platform} options={[...platforms].map((p) => [p, p])} />
      <FilterSelect
        name="asn"
        label="Network"
        value={filters.asn}
        options={networks.map((n) => [String(n.asn), `${n.name ?? "Unnamed"} (AS${n.asn})`])}
      />
      <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
        Words in the report
        <Input name="q" defaultValue={filters.q ?? ""} placeholder="e.g. timed out" maxLength={200} className="max-md:h-10" />
      </label>
      <button type="submit" className={cn(buttonVariants({ size: "sm" }), "sm:col-span-2 md:w-auto")}>
        Filter
      </button>
      </form>
    </div>
  );
}

function FilterSelect({
  name,
  label,
  value,
  options,
}: {
  name: string;
  label: string;
  value: string | undefined;
  options: [string, string][];
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <select name={name} defaultValue={value ?? ""} className={selectClass}>
        <option value="">Any</option>
        {options.map(([optionValue, text]) => (
          <option key={optionValue} value={optionValue}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
