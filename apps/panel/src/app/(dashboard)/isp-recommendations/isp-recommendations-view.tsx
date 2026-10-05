"use client";

import { useMemo, useState } from "react";
import { Network, Search } from "lucide-react";
import type { IspNetwork, IspRecommendationsSummary, IspTag } from "@/lib/types";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

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

export function IspRecommendationsView({ summary }: { summary: IspRecommendationsSummary }) {
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return summary.networks;
    return summary.networks.filter(
      (n: IspNetwork) => String(n.asn).includes(needle) || (n.org ?? "").toLowerCase().includes(needle),
    );
  }, [summary.networks, query]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">ISP Recommendations</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          What signed-in customers on each network experienced per route over the last {summary.windowHours} hours,
          counted as distinct people by their latest attempt. A route is tagged in the customer&apos;s picker only
          when at least five people on that network back the claim. These tags inform a customer&apos;s choice; the
          app&apos;s automatic failover does not use them.
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
                  <TableHead className="text-right" title="Distinct customers who dialled this route">
                    Tried
                  </TableHead>
                  <TableHead className="text-right" title="Latest attempt carried traffic">
                    Got through
                  </TableHead>
                  <TableHead className="text-right" title="Latest attempt got through, and had a session that kept passing health checks for 10+ minutes">
                    Stayed up
                  </TableHead>
                  <TableHead>Customer sees</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...network.routes]
                  .sort((a, b) => b.tried - a.tried)
                  .map((route) => (
                    <TableRow key={route.routeId}>
                      <TableCell className="text-sm">
                        {route.routeName ?? <span className="text-muted-foreground">deleted route</span>}
                        {route.nodeName ? (
                          <span className="ml-1 text-xs text-muted-foreground">{route.nodeName}</span>
                        ) : null}
                        {route.isRelay ? <span className="ml-1 text-xs text-muted-foreground">(relay)</span> : null}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {route.protocol ?? "--"}
                        {route.transport && route.transport !== "TCP" ? ` / ${route.transport}` : ""}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{route.tried}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {route.carried} <span className="text-xs text-muted-foreground">{share(route.carried, route.tried)}</span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {route.worked}{" "}
                        <span className="text-xs text-muted-foreground">{share(route.worked, route.tried)}</span>
                      </TableCell>
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
    </div>
  );
}
