"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Node, ProtocolConfig, Route } from "@/lib/types";
import { groupRoutesByServer, isRetiredRoute, routeServers } from "@/lib/retired";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RetiredSwitch } from "@/components/dashboard/retired-switch";

/** The plan editor's route list, one collapsible group per server.
 *
 * Selection lives in the parent's state, not in the checkboxes: a row in
 * a collapsed group, or one the filter hides, is not rendered, and a
 * form that read the ticks from the DOM would silently drop it on save.
 *
 * Retired servers' routes are hidden unless the switch is on -- except
 * any the plan still has ticked. Those are shown first, in their own
 * marked group, so they can be unticked: they are neither kept nor
 * dropped without someone seeing them.
 */
export function RoutePicker({
  routes,
  protocolConfigs,
  nodes,
  selected,
  onChange,
}: {
  routes: Route[];
  protocolConfigs: ProtocolConfig[];
  nodes: Node[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [showRetired, setShowRetired] = useState(false);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());

  const retired = useMemo(() => {
    const ids = new Set<string>();
    for (const r of routes) if (isRetiredRoute(routeServers(r, protocolConfigs, nodes))) ids.add(r.id);
    return ids;
  }, [routes, protocolConfigs, nodes]);
  const groups = useMemo(() => groupRoutesByServer(routes, protocolConfigs, nodes), [routes, protocolConfigs, nodes]);
  const retiredServerCount = nodes.filter((n) => n.status === "DISABLED").length;
  const staleTicked = routes.filter((r) => retired.has(r.id) && selected.has(r.id));

  const needle = filter.trim().toLowerCase();
  const matches = (route: Route, groupLabel: string) =>
    !needle || route.name.toLowerCase().includes(needle) || groupLabel.toLowerCase().includes(needle);

  const set = (ids: string[], on: boolean) => {
    const next = new Set(selected);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    onChange(next);
  };
  const toggleOpen = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const row = (route: Route) => (
    <label key={route.id} className="flex items-center gap-2 py-0.5 text-sm">
      <Checkbox checked={selected.has(route.id)} onCheckedChange={(checked) => set([route.id], checked === true)} />
      <span>{route.name}</span>
      {retired.has(route.id) ? (
        <span className="text-xs text-warning">(retired server)</span>
      ) : !route.isEnabled ? (
        <span className="text-xs text-muted-foreground">(disabled)</span>
      ) : null}
    </label>
  );

  if (routes.length === 0) return <p className="text-xs text-muted-foreground">No routes exist yet.</p>;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter servers or routes"
          aria-label="Filter routes"
          className="h-8 max-w-60"
        />
        <RetiredSwitch count={retiredServerCount} checked={showRetired} onCheckedChange={setShowRetired} />
      </div>

      {staleTicked.length > 0 ? (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2" data-testid="stale-routes">
          <p className="text-xs font-medium text-warning">
            Still on this plan, on retired servers ({staleTicked.length})
          </p>
          <p className="mb-1 text-xs text-muted-foreground">
            These stay on the plan when you save unless you untick them here.
          </p>
          {staleTicked.map(row)}
        </div>
      ) : null}

      <div className="flex flex-col rounded-md border border-white/8">
        {groups.map((group) => {
          const usable = group.routes.filter((r) => showRetired || !retired.has(r.id));
          if (usable.length === 0) return null;
          const shown = usable.filter((r) => matches(r, group.label));
          if (shown.length === 0) return null;
          const ticked = usable.filter((r) => selected.has(r.id)).length;
          const all = ticked === usable.length;
          const expanded = open.has(group.key) || needle.length > 0;
          return (
            <div key={group.key} className="border-b border-white/8 last:border-b-0">
              <div className="flex items-center gap-2 px-2 py-1.5">
                <Checkbox
                  aria-label={`Tick every route on ${group.label}`}
                  checked={all ? true : ticked > 0 ? "indeterminate" : false}
                  onCheckedChange={() => set(usable.map((r) => r.id), !all)}
                />
                <button
                  type="button"
                  onClick={() => toggleOpen(group.key)}
                  aria-expanded={expanded}
                  className="flex flex-1 items-center gap-1 text-left text-sm font-medium"
                >
                  {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                  {group.label}
                  {group.retired ? <span className="text-xs font-normal text-warning">retired</span> : null}
                  <span className="ml-auto text-xs font-normal text-muted-foreground">
                    {ticked} of {usable.length}
                  </span>
                </button>
              </div>
              {expanded ? <div className="flex flex-col pb-2 pl-8">{shown.map(row)}</div> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
