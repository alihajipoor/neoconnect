import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Loader2, MapPin, Repeat, X } from "lucide-react";
import { getAvailableRoutes, switchRoute } from "../lib/customer";
import { PROTOCOL_LABELS } from "../lib/protocol-labels";
import type { RouteOption } from "../lib/types";
import { cn } from "../lib/utils";
import { Button } from "./ui";
import { Latency } from "./Latency";
import { useI18n } from "../lib/i18n";

// Full-screen overlay, not a floating dialog -- this app's window is a
// fixed 400x640 (see tauri.conf.json), so "sheet slides over the whole
// window" reads better than a small centered modal would.
export function LocationPicker({
  subscriptionId,
  currentRouteId,
  onClose,
  onSwitched,
}: {
  subscriptionId: string;
  currentRouteId: string | undefined;
  onClose: () => void;
  /** Signals that the switch succeeded. Deliberately carries no payload:
   * the caller re-reads the provisioned connection itself, so this
   * component doesn't decide what the switch response is worth trusting. */
  onSwitched: () => void;
}) {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [routes, setRoutes] = useState<RouteOption[]>([]);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  /** Measured round-trip per route. Absent means "not measured yet",
   * which renders as "--" -- distinct from a measured failure, which is
   * an explicit null. Both are honest; neither invents a number. */
  const [latencies, setLatencies] = useState<Record<string, number | null>>({});

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    const result = await getAvailableRoutes(subscriptionId);
    if (result.ok) {
      setRoutes(result.data);
      void measureAll(result.data);
    } else {
      setError(result.error);
    }
    setLoading(false);
  }

  /** Times every server at once and fills each in as it lands.
   *
   * Deliberately not awaited by the caller: the list must render
   * immediately and populate, rather than making the customer wait on the
   * slowest server before seeing anything. A node the control plane
   * already knows is offline is skipped rather than timed out against --
   * there is no useful number for a server that is down.
   */
  async function measureAll(options: RouteOption[]) {
    await Promise.all(
      options.map(async (route) => {
        if (route.nodeStatus !== "ONLINE") {
          setLatencies((prev) => ({ ...prev, [route.id]: null }));
          return;
        }
        const ms = await invoke<number | null>("measure_latency", {
          host: route.endpoint.host,
          port: route.endpoint.port,
        }).catch(() => null);
        setLatencies((prev) => ({ ...prev, [route.id]: ms }));
      }),
    );
  }

  async function handlePick(route: RouteOption) {
    if (route.id === currentRouteId || switchingId) return;
    setSwitchError(null);
    setSwitchingId(route.id);
    const result = await switchRoute(subscriptionId, route.id);
    setSwitchingId(null);
    if (result.ok) {
      onSwitched();
      onClose();
    } else {
      setSwitchError(result.error);
    }
  }

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">{t("loc.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("loc.disconnectFirst")}</p>
        </div>
        <button
          onClick={onClose}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {loading ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <Button onClick={() => void load()}>{t("loc.retry")}</Button>
          </div>
        ) : routes.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            No locations available on your current plan.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {routes.map((route) => {
              const isCurrent = route.id === currentRouteId;
              const isSwitching = switchingId === route.id;
              return (
                <button
                  key={route.id}
                  onClick={() => void handlePick(route)}
                  disabled={isCurrent || switchingId !== null}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border px-3 py-3 text-left transition-colors disabled:cursor-default",
                    isCurrent
                      ? "border-primary/50 bg-primary/10"
                      : "border-white/10 bg-card/60 hover:border-white/20 hover:bg-card",
                  )}
                >
                  <div
                    className={cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-full",
                      isCurrent ? "bg-primary/20 text-primary" : "bg-highlight/15 text-highlight",
                    )}
                  >
                    <MapPin className="size-4" />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{route.location.nodeName}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {route.location.region} &middot; {PROTOCOL_LABELS[route.protocol]}
                    </span>
                  </div>
                  <Latency ms={route.id in latencies ? latencies[route.id] : null} />
                  {route.isRelay ? (
                    <span className="flex shrink-0 items-center gap-1 rounded-full bg-highlight/15 px-2 py-0.5 text-[10px] font-medium text-highlight">
                      <Repeat className="size-3" />
                      Relay
                    </span>
                  ) : null}
                  {isSwitching ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                  ) : isCurrent ? (
                    <Check className="size-4 shrink-0 text-primary" />
                  ) : null}
                </button>
              );
            })}
          </div>
        )}
        {switchError ? <p className="px-2 pt-2 text-xs text-destructive">{switchError}</p> : null}
      </div>
    </div>
  );
}
