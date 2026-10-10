import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Loader2, Repeat, Sparkles, X } from "lucide-react";
import { getAvailableRoutes, switchRoute } from "../lib/customer";
import { hasRecommended, pickerRows } from "../lib/isp-tags";
import { IspTagLine } from "./IspTagLine";
import { customerProtocolLabel } from "../lib/protocol-labels";
import type { RouteOption } from "../lib/types";
import { cn } from "../lib/utils";
import { Button } from "./ui";
import { Latency } from "./Latency";
import { Flag } from "./Flag";
import { useI18n } from "../lib/i18n";
import { failureText } from "../lib/failure-text";
import { useStillTrying } from "../lib/still-trying";

// Full-screen overlay, not a floating dialog -- this app's window is a
// fixed 400x640 (see tauri.conf.json), so "sheet slides over the whole
// window" reads better than a small centered modal would.
export function LocationPicker({
  subscriptionId,
  currentRouteId,
  onClose,
  onSwitched,
  tunnelActive = false,
  initialRoutes,
  automatic = false,
  onChooseAutomatic,
  onPicking,
  onPickFailed,
}: {
  /** Told the moment a server or Automatic is picked, before anything is
   * awaited -- a server's switch request can take seconds to answer, and
   * `onSwitched` waits for it. Whatever an automatic reconnect was doing
   * beneath the list ends here (`autoReconnect.choosing`): told only with
   * the answer, an attempt that began or landed in between dialled the
   * old route after the customer's press. With the server picked, or null
   * for Automatic: a tunnel kept up beneath the list is reconnected led by
   * the pick from then on, should it drop before the answer. */
  onPicking?: (routeId: string | null) => void;
  /** Told when a server's switch request fails: nothing was chosen, and
   * what the pick decided ahead of the answer is put back
   * (`autoReconnect.pickFailed`). */
  onPickFailed?: () => void;
  /** Whether nothing is pinned, so the ladder chooses -- what a new
   * install starts on. Marks the Automatic row as the current choice and
   * leaves every server row pickable, since picking one is how a
   * customer pins it. */
  automatic?: boolean;
  /** Offers the Automatic row first, and is called when it is chosen.
   * No server call: Automatic means "no pin", which lives on the device.
   * Absent, the row is not shown. */
  onChooseAutomatic?: () => void;
  subscriptionId: string;
  currentRouteId: string | undefined;
  /** Whether a tunnel is up right now.
   *
   * Latency is not measured while one is, because the measurement would
   * travel through it. A TCP connect to the very node the traffic is
   * already being tunnelled through takes almost no time, so every
   * server reads a handful of milliseconds -- reported from a real
   * phone, where the same list had shown a correct 150-170ms before the
   * first connect.
   *
   * This became true when the app stopped excluding itself from its own
   * tunnel, which it had to do so the egress check would stop declaring
   * working tunnels dead. Showing "--" while connected is the honest
   * answer: the number cannot be measured from in here, and inventing
   * one is the failure this component was written to avoid. */
  tunnelActive?: boolean;
  onClose: () => void;
  /** Signals that the switch succeeded. Deliberately carries no payload:
   * the caller re-reads the provisioned connection itself, so this
   * component doesn't decide what the switch response is worth trusting. */
  /** Reports which route the customer chose, so the dashboard can
   * pin it -- picking a server deliberately should not be quietly
   * overridden by failover. */
  onSwitched: (routeId: string) => void;
  /** What the dashboard already has, rendered immediately.
   *
   * The list used to start empty and fetch on open, so every time this
   * was opened the customer watched a spinner for a round trip to the
   * API -- three to ten seconds on a slow link, for data the dashboard
   * was already holding. Other VPN clients feel instant because they
   * show what they have and reconcile behind it; there was no reason
   * this could not.
   *
   * Still refreshed in the background, because a route can be added or
   * withdrawn between the dashboard's fetch and this being opened. The
   * difference is that the customer is not made to wait for it. */
  initialRoutes?: RouteOption[];
}) {
  const { t } = useI18n();
  const [routes, setRoutes] = useState<RouteOption[]>(initialRoutes ?? []);
  // Only a blocking load when there is genuinely nothing to show.
  const [loading, setLoading] = useState((initialRoutes ?? []).length === 0);
  const [error, setError] = useState<string | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  // Both waits are on Neoxify: the list is a read, given up to twenty
  // seconds an address, and a switch a write that first asks who answers.
  // Past eight seconds each says it is still trying rather than spinning
  // in silence.
  const loadingLong = useStillTrying(loading);
  const switchingLong = useStillTrying(switchingId !== null);
  /** Measured round-trip per route. Absent means "not measured yet",
   * which renders as "--" -- distinct from a measured failure, which is
   * an explicit null. Both are honest; neither invents a number. */
  const [latencies, setLatencies] = useState<Record<string, number | null>>({});
  /** Narrow the list to routes that worked for most people on this
   * network. Off by default: the tags are information, and hiding
   * everything else unasked would make the choice for the customer. */
  const [recommendedOnly, setRecommendedOnly] = useState(false);
  // What the list actually shows. Every index below -- focus, selection
  // -- is into this, not into `routes`.
  const rows = pickerRows(routes, recommendedOnly);
  // With Automatic chosen, no server row is "the current one": the ladder
  // decides at connect time, and every row stays a way to pin a server.
  const pinnedRouteId = automatic ? undefined : currentRouteId;

  useEffect(() => {
    void load();
    // Measuring starts against whatever is on screen now rather than
    // waiting for the refresh, so the numbers fill in while the list is
    // already readable.
    if ((initialRoutes ?? []).length > 0) void measureAll(initialRoutes ?? []);
  }, []);

  async function load() {
    setError(null);
    // A wait, when there is nothing on screen to show meanwhile -- the
    // Retry after an error. Left false there, the list fell through to
    // "No locations available on your current plan" for as long as the
    // request took, which is up to twenty seconds an address now, and is
    // not something anybody had been told.
    setLoading(routes.length === 0);
    const result = await getAvailableRoutes(subscriptionId);
    if (result.ok) {
      setRoutes(result.data);
      void measureAll(result.data);
    } else if (routes.length === 0) {
      // A failed refresh must not blank a list the customer can see and
      // use. It only becomes an error when there is nothing behind it.
      setError(failureText(result, t));
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
    // Nothing is measurable from inside a tunnel -- see `tunnelActive`.
    // Leaving the map empty renders every row as "--", which is what
    // "not measured" already means here.
    if (tunnelActive) return;
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

  /* One tab stop for the whole list, arrow keys to move within it.
   *
   * Every row being its own tab stop meant reaching the last server took
   * fifteen presses, and this list only grows as nodes are added. That
   * is invisible with a mouse and miserable without one -- and "without
   * one" includes anyone driving this over a remote desktop, which is
   * how it was found.
   *
   * A disabled button cannot take focus, and the current route's row is
   * disabled, so the roving stop has to skip it rather than land on it
   * and silently do nothing. */
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [focusedIndex, setFocusedIndex] = useState(0);

  function selectable(i: number) {
    return Boolean(rows[i]) && rows[i].id !== pinnedRouteId && switchingId === null;
  }

  useEffect(() => {
    if (rows.length === 0 || selectable(focusedIndex)) return;
    const next = rows.findIndex((_, i) => selectable(i));
    if (next >= 0) setFocusedIndex(next);
    // Deliberately not depending on focusedIndex: this only exists to
    // rescue a stop that has become unreachable, and re-running it on
    // every focus change would drag focus back the moment the customer
    // arrowed onto a different row.
  }, [routes, recommendedOnly, pinnedRouteId, switchingId]);

  /* Put focus on a row as soon as there are rows.
   *
   * The roving tab stop above only responds once focus is already on a
   * row, because the handler lives on the list and only sees events
   * bubbling out of its children. Opening the sheet left focus outside
   * it, so the first two Tab presses went to the header's close button
   * and the arrow keys did nothing at all -- no movement, no focus ring,
   * nothing to explain why. Found driving this by keyboard.
   *
   * Once per open, guarded by a ref rather than by state: re-running it
   * would yank focus back to the top every time the customer arrowed
   * away, which is the same bug wearing a different hat. */
  const autoFocusedRef = useRef(false);
  useEffect(() => {
    if (loading || rows.length === 0 || autoFocusedRef.current) return;
    const first = rows.findIndex((_, i) => selectable(i));
    if (first < 0) return;
    autoFocusedRef.current = true;
    setFocusedIndex(first);
    rowRefs.current[first]?.focus();
  }, [loading, routes]);

  /* Escape closes the sheet.
   *
   * It covers the whole overlay rather than the list, so it works while
   * the list is still loading, while an error is showing, and wherever
   * focus happens to be -- a dismissal that only works from one element
   * is barely a dismissal.
   *
   * Deliberately inert mid-switch: the request is already with the
   * server and closing here would not recall it, so honouring Escape
   * would imply a cancellation that did not happen. Same rule the rest
   * of this app follows about not claiming things it has not done. */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || switchingId !== null) return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [switchingId, onClose]);

  function moveFocus(delta: number) {
    if (rows.length === 0) return;
    let i = focusedIndex;
    for (let n = 0; n < rows.length; n += 1) {
      i = (i + delta + rows.length) % rows.length;
      if (selectable(i)) break;
    }
    setFocusedIndex(i);
    rowRefs.current[i]?.focus();
  }

  function onListKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(-1);
    }
  }

  async function handlePick(route: RouteOption) {
    if (route.id === pinnedRouteId || switchingId) return;
    // The press, heard as it is made -- not once the request answers.
    onPicking?.(route.id);
    setSwitchError(null);
    setSwitchingId(route.id);
    const result = await switchRoute(subscriptionId, route.id);
    setSwitchingId(null);
    if (result.ok) {
      onSwitched(route.id);
      onClose();
    } else {
      onPickFailed?.();
      setSwitchError(failureText(result, t));
    }
  }

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">{t("loc.title")}</h2>
          {/* Only true while a tunnel is up. Shown unconditionally it
              told a disconnected customer to disconnect first, which
              reads as the app not knowing its own state -- and this
              screen's whole job is being trusted about what it reports. */}
          <p className="text-xs text-muted-foreground">
            {t(tunnelActive ? "loc.disconnectFirst" : "loc.pickHint")}
          </p>
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
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {loadingLong ? <p className="text-xs">{t("common.stillTrying")}</p> : null}
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
          <>
          {/* Automatic first, because the people this exists for are the
              ones who open the list, try the first few rows by hand, hit
              a blocked one and decide the app is broken. Choosing it
              hands the order back to the ladder, which already moves on
              by itself -- and on a network this device has never seen,
              now leans on what worked for others there. */}
          {onChooseAutomatic ? (
            <button
              type="button"
              onClick={() => {
                if (automatic || switchingId) return;
                onPicking?.(null);
                onChooseAutomatic();
                onClose();
              }}
              disabled={switchingId !== null}
              aria-pressed={automatic}
              className={cn(
                "mb-2 flex w-full items-center gap-3 rounded-lg border px-3 py-3 text-start transition-colors disabled:cursor-default",
                automatic
                  ? "border-primary/50 bg-primary/10"
                  : "border-white/10 bg-card/60 hover:border-white/20 hover:bg-card",
              )}
            >
              <div
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-full",
                  automatic ? "bg-primary/20 text-primary" : "bg-highlight/10 text-highlight",
                )}
              >
                <Sparkles className="size-4" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{t("loc.automatic")}</span>
                <span className="text-xs text-muted-foreground">{t("loc.automaticHint")}</span>
              </div>
              {automatic ? <Check className="size-4 shrink-0 text-primary" /> : null}
            </button>
          ) : null}
          {/* Only offered when there is something to narrow to. A filter
              that empties the list would read as "nothing works here",
              which is not what an absence of evidence means. */}
          {hasRecommended(routes) ? (
            <label className="mb-2 flex cursor-pointer items-center gap-2 px-1 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={recommendedOnly}
                onChange={(event) => setRecommendedOnly(event.target.checked)}
                className="accent-primary"
              />
              {t("loc.recommendedOnly")}
            </label>
          ) : null}
          <div className="flex flex-col gap-2" onKeyDown={onListKeyDown}>
            {rows.map((route, index) => {
              const isCurrent = route.id === pinnedRouteId;
              const isSwitching = switchingId === route.id;
              return (
                <button
                  key={route.id}
                  ref={(el) => {
                    rowRefs.current[index] = el;
                  }}
                  tabIndex={index === focusedIndex ? 0 : -1}
                  onFocus={() => setFocusedIndex(index)}
                  onClick={() => void handlePick(route)}
                  disabled={isCurrent || switchingId !== null}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border px-3 py-3 text-start transition-colors disabled:cursor-default",
                    isCurrent
                      ? "border-primary/50 bg-primary/10"
                      : "border-white/10 bg-card/60 hover:border-white/20 hover:bg-card",
                  )}
                >
                  {/* The flag, not a pin. Every row used to carry the
                      same pin, which told the customer nothing they
                      could not already read -- while the one thing they
                      actually scan a server list for, the country, was
                      buried in a slug like "fr-france". */}
                  <div
                    className={cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-full",
                      isCurrent ? "bg-primary/20" : "bg-highlight/10",
                    )}
                  >
                    <Flag region={route.location.region} className="h-4 w-[1.35rem]" />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm font-medium">{route.location.nodeName}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {route.location.region} &middot; {customerProtocolLabel(route.protocol, route.transport)}
                    </span>
                    <IspTagLine tag={route.ispTag} t={t} />
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
          </>
        )}
        {switchingLong ? <p className="px-2 pt-2 text-xs text-muted-foreground">{t("common.stillTrying")}</p> : null}
        {switchError ? <p className="px-2 pt-2 text-xs text-destructive">{switchError}</p> : null}
      </div>
    </div>
  );
}
