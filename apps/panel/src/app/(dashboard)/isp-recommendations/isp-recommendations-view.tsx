"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, Network, Search } from "lucide-react";
import type {
  IspNetwork,
  IspRecommendationsSummary,
  IspRoute,
  IspRouteStats,
  IspRouteTraffic,
  IspTag,
} from "@/lib/types";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn, formatBytes } from "@/lib/utils";

/** The tag exactly as a customer on that network sees it, in the
 * operator's words. Grey "none" is the common case and means "not enough
 * people yet", not "neutral verdict". */
const TAGS: Record<IspTag["code"], { label: string; className: string }> = {
  worksOnYourIsp: {
    label: "Shown: works for most",
    className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
  },
  failingOnYourIsp: {
    label: "Shown: failing for most",
    className: "border-red-500/30 bg-red-500/10 text-red-400",
  },
};

function TagCell({ tag }: { tag: IspTag | null }) {
  if (!tag) return <span className="text-xs text-muted-foreground">none</span>;
  const look = TAGS[tag.code];
  return (
    <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-xs font-medium", look.className)}>
      {look.label} ({tag.customers}/{tag.outOf})
    </span>
  );
}

function share(part: number, whole: number) {
  return whole === 0 ? "--" : `${Math.round((part / whole) * 100)}%`;
}

/** Route rows are ordered by people who tried (the evidence behind a tag)
 * or by what the route actually carried. */
type SortKey = "tried" | "traffic" | "withUpload";

const totalBytes = (t: IspRouteTraffic) => Number(t.bytesUp) + Number(t.bytesDown);

const ORDER: Record<SortKey, (a: IspRouteStats, b: IspRouteStats) => number> = {
  tried: (a, b) => b.tried - a.tried || totalBytes(b.traffic) - totalBytes(a.traffic),
  traffic: (a, b) => totalBytes(b.traffic) - totalBytes(a.traffic) || b.tried - a.tried,
  withUpload: (a, b) => b.traffic.withUpload - a.traffic.withUpload || totalBytes(b.traffic) - totalBytes(a.traffic),
};

function SortHead({
  sortKey,
  current,
  onSort,
  title,
  children,
}: {
  sortKey: SortKey;
  current: SortKey;
  onSort: (key: SortKey) => void;
  title: string;
  children: ReactNode;
}) {
  const active = sortKey === current;
  return (
    <TableHead className="text-right" title={title} aria-sort={active ? "descending" : undefined}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn("inline-flex items-center gap-1 hover:text-foreground", active && "text-foreground")}
      >
        {children}
        <ArrowDown className={cn("size-3", active ? "opacity-100" : "opacity-0")} aria-hidden />
      </button>
    </TableHead>
  );
}

function RouteCells({ route }: { route: IspRoute }) {
  return (
    <>
      <TableCell className="text-sm">
        {route.routeName ?? <span className="text-muted-foreground">deleted route</span>}
        {route.nodeName ? <span className="ml-1 text-xs text-muted-foreground">{route.nodeName}</span> : null}
        {route.isRelay ? <span className="ml-1 text-xs text-muted-foreground">(relay)</span> : null}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {route.protocol ?? "--"}
        {route.transport && route.transport !== "TCP" ? ` / ${route.transport}` : ""}
      </TableCell>
    </>
  );
}

/** Up and down, then the customers who sent anything worth counting,
 * then what a typical one of them moved. */
function TrafficCells({ traffic }: { traffic: IspRouteTraffic }) {
  const none = traffic.customers === 0;
  return (
    <>
      <TableCell className="text-right tabular-nums">
        {none ? (
          <span className="text-xs text-muted-foreground">none</span>
        ) : (
          <>
            <span className="text-xs text-muted-foreground">↑</span> {formatBytes(traffic.bytesUp)}{" "}
            <span className="ml-1 text-xs text-muted-foreground">↓</span> {formatBytes(traffic.bytesDown)}
          </>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {none ? (
          <span className="text-xs text-muted-foreground">--</span>
        ) : (
          <>
            {traffic.withUpload} <span className="text-xs text-muted-foreground">of {traffic.customers}</span>
          </>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {traffic.typicalBytes === null ? (
          <span className="text-xs text-muted-foreground">--</span>
        ) : (
          formatBytes(traffic.typicalBytes)
        )}
      </TableCell>
    </>
  );
}

const TRAFFIC_TITLE = "Bytes the servers metered on this route for customers placed on this network: up (sent by the device) and down";
const UPLOAD_TITLE =
  "Customers who sent at least 1 MB on this route, of all customers with any traffic on it. Download alone is what a disconnected WireGuard device looks like";
const TYPICAL_TITLE = "Median traffic (up + down) per customer with upload";

export function IspRecommendationsView({ summary }: { summary: IspRecommendationsSummary }) {
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("tried");

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return summary.networks;
    return summary.networks.filter(
      (n: IspNetwork) => String(n.asn).includes(needle) || (n.org ?? "").toLowerCase().includes(needle),
    );
  }, [summary.networks, query]);

  const withoutRoute = summary.withoutRoute;
  const showUnplaced = !query.trim() && (summary.unattributed.length > 0 || withoutRoute.customers > 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex max-w-3xl flex-col gap-2">
        <h1 className="text-xl font-semibold">ISP Recommendations</h1>
        <p className="text-sm text-muted-foreground">
          What signed-in customers on each network experienced per route over the last {summary.windowHours} hours,
          counted as distinct people by their latest attempt. A route is tagged in the customer&apos;s picker only
          when at least five people on that network back the claim. These tags inform a customer&apos;s choice; the
          app&apos;s automatic failover does not use them.
        </p>
        <p className="text-xs text-muted-foreground">
          Traffic is what the servers metered on the route in the same window. Usage records carry no network, so each
          hour of a customer&apos;s usage goes to the network of their latest report on that route by then: someone who
          switches networks mid-window is counted under whichever network they had reported from last at the time.
          &ldquo;With upload&rdquo; counts customers who sent at least 1 MB.
        </p>
      </div>

      {!summary.dataset.loaded ? (
        <Card className="border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-300">
          The IP-to-network table is not loaded, so no report can be placed on a network and no customer is shown
          a tag. Check the backend log for the ASN dataset download.
        </Card>
      ) : null}
      {summary.truncated ? (
        <Card className="p-4 text-sm text-muted-foreground">
          Only the most recent reports were read; counts on this page are lower bounds.
        </Card>
      ) : null}

      <div className="relative sm:w-72">
        <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search ASN or network name"
          className="pl-9"
          aria-label="Search networks"
        />
      </div>

      {visible.length === 0 ? (
        <div className="rounded-lg border border-white/8 bg-card/40 py-10 text-center text-sm text-muted-foreground">
          <Network className="mx-auto mb-2 size-5 opacity-50" />
          {summary.networks.length > 0
            ? "No network matches that search."
            : "No reports with a known network in the window. Clients send one only once they are on a version that carries the network attestation."}
        </div>
      ) : (
        visible.map((network) => (
          <div key={network.asn} className="rounded-lg border border-white/8 bg-card/40">
            <div className="flex items-baseline gap-2 border-b border-white/8 px-4 py-3">
              <span className="font-medium">{network.org || "Unknown network"}</span>
              <span className="text-xs text-muted-foreground">AS{network.asn}</span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Route</TableHead>
                  <TableHead>Protocol</TableHead>
                  <SortHead sortKey="tried" current={sortBy} onSort={setSortBy} title="Distinct customers who dialled this route">
                    Tried
                  </SortHead>
                  <TableHead className="text-right" title="Latest attempt carried traffic">
                    Got through
                  </TableHead>
                  <TableHead className="text-right" title="Latest attempt got through, and had a session that kept passing health checks for 10+ minutes">
                    Stayed up
                  </TableHead>
                  <SortHead sortKey="traffic" current={sortBy} onSort={setSortBy} title={TRAFFIC_TITLE}>
                    Traffic
                  </SortHead>
                  <SortHead sortKey="withUpload" current={sortBy} onSort={setSortBy} title={UPLOAD_TITLE}>
                    With upload
                  </SortHead>
                  <TableHead className="text-right" title={TYPICAL_TITLE}>
                    Typical
                  </TableHead>
                  <TableHead>Customer sees</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...network.routes].sort(ORDER[sortBy]).map((route) => (
                  <TableRow key={route.routeId}>
                    <RouteCells route={route} />
                    <TableCell className="text-right tabular-nums">{route.tried}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {route.carried} <span className="text-xs text-muted-foreground">{share(route.carried, route.tried)}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {route.worked}{" "}
                      <span className="text-xs text-muted-foreground">{share(route.worked, route.tried)}</span>
                    </TableCell>
                    <TrafficCells traffic={route.traffic} />
                    <TableCell>
                      <TagCell tag={route.tag} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))
      )}

      {showUnplaced ? (
        <div className="rounded-lg border border-white/8 bg-card/40">
          <div className="flex flex-col gap-1 border-b border-white/8 px-4 py-3">
            <span className="font-medium">Not placed on a network</span>
            <span className="text-xs text-muted-foreground">
              Traffic from customers with no report on that route from a known network in the window, usually an app
              too old to send one.
            </span>
          </div>
          {summary.unattributed.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Route</TableHead>
                  <TableHead>Protocol</TableHead>
                  <TableHead className="text-right" title={TRAFFIC_TITLE}>
                    Traffic
                  </TableHead>
                  <TableHead className="text-right" title={UPLOAD_TITLE}>
                    With upload
                  </TableHead>
                  <TableHead className="text-right" title={TYPICAL_TITLE}>
                    Typical
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.unattributed.map((route) => (
                  <TableRow key={route.routeId}>
                    <RouteCells route={route} />
                    <TrafficCells traffic={route.traffic} />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
          {withoutRoute.customers > 0 ? (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              Also ↑ {formatBytes(withoutRoute.bytesUp)} ↓ {formatBytes(withoutRoute.bytesDown)} from{" "}
              {withoutRoute.customers} {withoutRoute.customers === 1 ? "customer" : "customers"} on credentials removed
              since (a device that signed out, or went idle, gives its credential back), which name no route.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
