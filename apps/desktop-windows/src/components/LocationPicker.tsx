import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, CircleCheck, Loader2, Repeat, Sparkles, X } from "lucide-react";
import { getAvailableRoutes, switchRoute } from "../lib/customer";
import { hasRecommended, pickerRows } from "../lib/isp-tags";
import { IspTagLine } from "./IspTagLine";
import { customerProtocolLabel } from "../lib/protocol-labels";
import type { RouteOption } from "../lib/types";
import { cn } from "../lib/utils";
import { Button, PillButton } from "./ui";
import { Latency } from "./Latency";
import { RouteFlag } from "./Flag";
import { useI18n } from "../lib/i18n";
import { failureText, type ShownFailure } from "../lib/failure-text";
import { useStillTrying } from "../lib/still-trying";
import { traceRequests } from "../lib/unanswered-report";
import { routesToAdopt } from "../lib/picker-routes";
import { groupByPlace, placeKey, placeLabel, routePlace } from "../lib/route-place";
import { LocationList, type ListEvidence } from "./LocationList";

export type { ListEvidence } from "./LocationList";

/** The last timing of the list, in memory for this run: the panel, the
 * sheet and the Locations page are separate mounts of the list, and a
 * measurement taken in one is shown, with its age, in the others rather
 * than taken again -- a list that timed every server each time it was
 * opened would be a visible probe pattern on a censored network. */
let lastTiming: { subscriptionId: string; at: number; values: Record<string, number | null> } | null = null;

// Four forms, one list: the full-window overlay the phone app opens from
// its card ("overlay"), and the redesign's three -- the desktop's locations
// panel beside the hero ("panel"), the phone-sized window's sheet ("sheet")
// and the Locations page ("page"; LocationList.tsx draws those three). The
// picking, the reconnect wiring and the honesty rules are the same in all.
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
  connectionState,
  onRoutes,
  variant = "overlay",
  confirmPick,
  evidence,
  onOpenFull,
  focusSection,
}: {
  /** The Locations page, from the panel's menu. */
  onOpenFull?: (section?: "explain") => void;
  /** The page opened at a section: its explanation of the protocols. */
  focusSection?: "explain";
  /** The map's evidence, for the list to agree with it. Absent -- the
   * phone app -- the filter reads the per-network tags alone, as before. */
  evidence?: ListEvidence;
  /** "overlay" is the full-window list the phone app opens from its card;
   * "panel" the Pearl Glass locations panel the desktop keeps beside the
   * hero; "sheet" the phone-sized window's sheet; "page" the Locations
   * page. The panel is always there, so it does not fetch the list or time
   * every server on its own when it appears -- the dashboard's own loads
   * feed it, and latency is measured when the customer asks: a list that
   * dialled every endpoint each time the window opened would be a visible
   * probe pattern on a censored network. The sheet and the page are opened
   * on purpose, as the overlay is: they refresh the list, and time the
   * servers once if nothing has timed them yet in this run. */
  variant?: "overlay" | "panel" | "sheet" | "page";
  /** Asked before a pick goes ahead, with the route (null for Automatic):
   * while a tunnel is up the dashboard confirms the switch and takes the
   * tunnel down first. False leaves everything as it was. */
  confirmPick?: (route: RouteOption | null) => Promise<boolean>;
  /** Told the list this picker's own request was answered with, and for
   * which subscription: newer than anything the dashboard holds. It stayed
   * in the picker, and the dashboard -- with nothing cached, its own
   * request having failed -- went on writing an empty list into the
   * snapshot, so the next start with Neoxify out of reach had no servers
   * to show although a list had been fetched. */
  onRoutes?: (subscriptionId: string, routes: RouteOption[]) => void;
  /** The connection state the dashboard beneath shows, as it changes. For
   * the report on a list or a switch nothing answered: its socket-level
   * probe must not run across a connect or a disconnect, and the list
   * stays open while the dashboard does either (unanswered-report.ts). */
  connectionState?: string;
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
  const { t, language } = useI18n();
  const panel = variant === "panel";
  const overlay = variant === "overlay";
  const [routes, setRoutes] = useState<RouteOption[]>(initialRoutes ?? []);
  // Only a blocking load when there is genuinely nothing to show -- and
  // never in the panel, which loads only when asked.
  const [loading, setLoading] = useState(!panel && (initialRoutes ?? []).length === 0);
  // Kept as they came, and worded as the list renders (`ShownFailure`).
  const [error, setError] = useState<ShownFailure | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<ShownFailure | null>(null);
  // Both waits are on Neoxify: the list is a read, given up to twenty
  // seconds an address, and a switch a write that first asks who answers.
  // Past eight seconds each says it is still trying rather than spinning
  // in silence.
  const loadingLong = useStillTrying(loading);
  const switchingLong = useStillTrying(switchingId !== null);
  /** Measured round-trip per route. Absent means "not measured yet",
   * which renders as "--" -- distinct from a measured failure, which is
   * an explicit null. Both are honest; neither invents a number. */
  const [latencies, setLatencies] = useState<Record<string, number | null>>(() =>
    !overlay && lastTiming?.subscriptionId === subscriptionId ? { ...lastTiming.values } : {},
  );
  /** When the figures on screen were taken, and whether a timing runs now. */
  const [measuredAt, setMeasuredAt] = useState<number | null>(() =>
    !overlay && lastTiming?.subscriptionId === subscriptionId ? lastTiming.at : null,
  );
  const [measuring, setMeasuring] = useState(false);
  const measuringRef = useRef(false);
  /** Narrow the list to routes that worked for most people on this
   * network. Off by default: the tags are information, and hiding
   * everything else unasked would make the choice for the customer. */
  const [recommendedOnly, setRecommendedOnly] = useState(false);
  // What the list actually shows. Every index below -- focus, selection
  // -- is into this, not into `routes`. Routes to one place sit
  // together (`groupByPlace`): with relays named by their exit, the
  // server's name order put Iran → Germany and Iran → France in turns.
  const rows = groupByPlace(
    evidence ? workedRows(routes, recommendedOnly, evidence.worked) : pickerRows(routes, recommendedOnly),
  );
  // The filter, only when there is something to narrow to.
  const canNarrow = evidence ? routes.some((r) => evidence.worked.has(placeKey(r))) : hasRecommended(routes);
  // With Automatic chosen, no server row is "the current one": the ladder
  // decides at connect time, and every row stays a way to pin a server.
  const pinnedRouteId = automatic ? undefined : currentRouteId;
  // Read when a request settles, not when it began: see `connectionState`.
  const stateRef = useRef(connectionState);
  stateRef.current = connectionState;
  // The rows as the latest render has them, for a request that settles
  // after the dashboard has offered a list (`routesToAdopt`).
  const routesRef = useRef(routes);
  routesRef.current = routes;
  // Whether this picker's own request for the list has answered, and
  // whether one is out now.
  const ownAnswered = useRef(false);
  const ownPending = useRef(false);

  // A list the dashboard puts on screen after this opened, while this
  // picker's own request has not answered: the dashboard's route request
  // was still out when the picker opened, or has learned more since. See
  // `routesToAdopt`.
  useEffect(() => {
    const adopted = routesToAdopt(routesRef.current, ownAnswered.current, initialRoutes);
    if (adopted === null) return;
    setRoutes(adopted);
    setError(null);
    if (adopted.length > 0) {
      setLoading(false);
      if (!panel) measureIfDue(adopted);
      return;
    }
    // Taken away: they were another plan's. This plan's list is the
    // picker's own request's to find -- still out, or asked again.
    if (ownPending.current) setLoading(true);
    else void load();
  }, [initialRoutes]);

  useEffect(() => {
    // The panel is fed by the dashboard: see `variant`.
    if (panel) return;
    void load();
    // Measuring starts against whatever is on screen now rather than
    // waiting for the refresh, so the numbers fill in while the list is
    // already readable.
    if ((initialRoutes ?? []).length > 0) measureIfDue(initialRoutes ?? []);
  }, []);

  async function load() {
    setError(null);
    // A wait, when there is nothing on screen to show meanwhile -- the
    // Retry after an error. Left false there, the list fell through to
    // "No locations available on your current plan" for as long as the
    // request took, which is up to twenty seconds an address now, and is
    // not something anybody had been told.
    setLoading(routesRef.current.length === 0);
    // Traced, so a list that nothing answered is reported with the
    // addresses it tried, whether or not the customer saw an error for
    // it. See unanswered-report.ts.
    const requests = traceRequests("server list", () => stateRef.current);
    ownPending.current = true;
    const result = await getAvailableRoutes(subscriptionId, requests.trace("routes")).finally(() => {
      ownPending.current = false;
    });
    const unanswered = requests.settle({ routes: result });
    const throughTunnel = tunnelActive ? "; a tunnel was up" : "";
    // Read now: the dashboard may have offered a list while this waited.
    const shown = routesRef.current;
    if (result.ok) {
      ownAnswered.current = true;
      setRoutes(result.data);
      onRoutes?.(subscriptionId, result.data);
      measureIfDue(result.data);
    } else if (shown.length === 0) {
      // A failed refresh must not blank a list the customer can see and
      // use. It only becomes an error when there is nothing behind it.
      setError(result);
      unanswered?.(`showed the error, with no servers to list${throughTunnel}`);
    } else {
      unanswered?.(`kept the ${shown.length} servers already on screen${throughTunnel}`);
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
    measuringRef.current = true;
    setMeasuring(true);
    const taken: Record<string, number | null> = {};
    await Promise.all(
      options.map(async (route) => {
        if (route.nodeStatus !== "ONLINE") {
          taken[route.id] = null;
          setLatencies((prev) => ({ ...prev, [route.id]: null }));
          return;
        }
        const ms = await invoke<number | null>("measure_latency", {
          host: route.endpoint.host,
          port: route.endpoint.port,
        }).catch(() => null);
        taken[route.id] = ms;
        setLatencies((prev) => ({ ...prev, [route.id]: ms }));
      }),
    );
    measuringRef.current = false;
    setMeasuring(false);
    const at = Date.now();
    setMeasuredAt(at);
    lastTiming = { subscriptionId, at, values: taken };
  }

  /** The overlay times the list each time it gets one, as it always has.
   * The redesign's lists time it once a run, and again when asked. */
  function measureIfDue(options: RouteOption[]) {
    if (overlay) {
      void measureAll(options);
      return;
    }
    if (measuringRef.current || lastTiming?.subscriptionId === subscriptionId) return;
    void measureAll(options);
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
    // Nothing autofocuses in the panel: it sits beside the hero, and taking
    // focus there would take it from wherever the customer was.
    if (!overlay || loading || rows.length === 0 || autoFocusedRef.current) return;
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
      if (panel || variant === "page" || event.key !== "Escape" || switchingId !== null) return;
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
    // Over a live tunnel, the dashboard asks first and takes it down.
    if (confirmPick && !(await confirmPick(route))) return;
    // The press, heard as it is made -- not once the request answers.
    onPicking?.(route.id);
    setSwitchError(null);
    setSwitchingId(route.id);
    // A switch that nothing answered shows the same sentence as a list
    // that could not be had -- over rows the customer can see -- and it
    // left no report either.
    const requests = traceRequests("server switch", () => stateRef.current);
    const result = await switchRoute(subscriptionId, route.id, requests.trace("switch"));
    const unanswered = requests.settle({ switch: result });
    setSwitchingId(null);
    if (result.ok) {
      onSwitched(route.id);
      onClose();
    } else {
      onPickFailed?.();
      setSwitchError(result);
      // Not "nothing was switched": a request whose answer was lost may
      // still have arrived.
      unanswered?.(`showed the error and kept the previous choice${tunnelActive ? "; a tunnel was up" : ""}`);
    }
  }

  /** Automatic: no server call -- it means "no pin", which lives on the
   * device. Over a live tunnel, the dashboard asks first and takes it down. */
  async function pickAutomatic() {
    if (!onChooseAutomatic) return;
    if (automatic || switchingId) return;
    if (confirmPick && !(await confirmPick(null))) return;
    onPicking?.(null);
    onChooseAutomatic();
    onClose();
  }

  // The list's own waits and failures, the same in every form.
  const status = loading ? (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {loadingLong ? <p className="text-xs">{t("common.stillTrying")}</p> : null}
    </div>
  ) : error ? (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-sm text-destructive">{failureText(error, t)}</p>
      <Button onClick={() => void load()}>{t("loc.retry")}</Button>
    </div>
  ) : routes.length === 0 ? (
    panel ? (
      // The panel loads only when asked: an empty list here is one
      // that has not arrived, not a plan with nothing on it.
      <div className="flex flex-col items-center gap-3 px-4 py-8 text-center text-sm text-ink-2">
        <p className="m-0">{t("loc.notLoaded")}</p>
        <PillButton variant="ghost" size="sm" onClick={() => void load()}>
          {t("loc.retry")}
        </PillButton>
      </div>
    ) : (
      <p className="px-2 py-6 text-center text-sm text-muted-foreground">{t("loc.noLocations")}</p>
    )
  ) : null;

  const after = (
    <>
      {switchingLong ? <p className="px-2 pt-2 text-xs text-muted-foreground">{t("common.stillTrying")}</p> : null}
      {switchError ? <p className="px-2 pt-2 text-xs text-destructive">{failureText(switchError, t)}</p> : null}
    </>
  );

  if (!overlay) {
    return (
      <LocationList
        variant={variant}
        routes={routes}
        latencies={latencies}
        measuring={measuring}
        measuredAt={measuredAt}
        tunnelActive={tunnelActive}
        connectionState={connectionState}
        pinnedRouteId={pinnedRouteId}
        currentRouteId={currentRouteId}
        automatic={automatic}
        showAutomatic={onChooseAutomatic !== undefined}
        switchingId={switchingId}
        evidence={evidence}
        onPick={(route) => void handlePick(route)}
        onAutomatic={() => void pickAutomatic()}
        // Latency on request: see `variant`. Not from inside a tunnel.
        onMeasure={() => {
          if (!tunnelActive && !measuringRef.current) void measureAll(routesRef.current);
        }}
        onOpenFull={onOpenFull}
        focusSection={focusSection}
        status={status}
        after={after}
      />
    );
  }

  // The phone app's overlay, as it was before the redesign: its own
  // dashboard keeps the old look until the phone's phase.
  const automaticRow = onChooseAutomatic ? (
    <button
      type="button"
      onClick={() => void pickAutomatic()}
      disabled={switchingId !== null}
      aria-pressed={automatic}
      className={cn(
        "mb-2 flex w-full items-center gap-3 rounded-lg border px-3 py-3 text-start transition-colors disabled:cursor-default",
        automatic ? "border-primary/50 bg-primary/10" : "border-white/10 bg-card/60 hover:border-white/20 hover:bg-card",
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
  ) : null;

  const list = (
    <>
      {automaticRow}
      {/* Only offered when there is something to narrow to. A filter
          that empties the list would read as "nothing works here",
          which is not what an absence of evidence means. */}
      {canNarrow ? (
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
          const place = routePlace(route);
          const placeName = placeLabel(route, language);
          const protocol = customerProtocolLabel(route.protocol, route.transport);
          const ownAt = evidence?.ownAt(route) ?? null;
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
                isCurrent ? "border-primary/50 bg-primary/10" : "border-white/10 bg-card/60 hover:border-white/20 hover:bg-card",
              )}
            >
              {/* The flag, not a pin: the country is what the list is
                  scanned for. A relay shows its exit's flag with Iran's
                  as a badge, since the exit is the country being chosen. */}
              <div
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-full",
                  isCurrent ? "bg-primary/20" : "bg-highlight/10",
                )}
              >
                <RouteFlag region={place.entry} exitRegion={place.exit} label={placeName} />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                {/* The country -- "Iran → Germany" for a relay -- over the
                    node and protocol, which is where two routes to one
                    place differ. */}
                <span className="truncate text-sm font-medium">{placeName}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {route.location.nodeName} &middot; {protocol}
                </span>
                {ownAt !== null ? (
                  <span
                    className="flex min-w-0 items-center gap-1 text-[11px] text-success"
                    data-own-worked=""
                    title={t("loc.ownWorkedTip")}
                    aria-label={`${t("loc.ownWorked")}. ${t("loc.ownWorkedTip")}`}
                  >
                    <CircleCheck className="size-3 shrink-0" aria-hidden />
                    <span className="truncate">{t("loc.ownWorked")}</span>
                  </span>
                ) : evidence && !evidence.tags ? null : (
                  <IspTagLine tag={route.ispTag} t={t} />
                )}
              </div>
              <Latency ms={route.id in latencies ? latencies[route.id] : null} />
              {route.isRelay ? (
                <span className="flex shrink-0 items-center gap-1 rounded-full bg-highlight/15 px-2 py-0.5 text-[10px] font-medium text-highlight">
                  <Repeat className="size-3" />
                  {t("loc.relayPill")}
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
  );

  const body = (
    <>
      {status ?? list}
      {after}
    </>
  );

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

      <div className="flex-1 overflow-y-auto px-3 py-3">{body}</div>
    </div>
  );
}

/** The rows for the "Worked here" filter from the map's evidence, in the
 * order the server sent them. As `pickerRows`: narrowing never reorders,
 * and a filter that would leave nothing shows everything instead -- an
 * absence of evidence is not "nothing works here". */
function workedRows(routes: readonly RouteOption[], workedOnly: boolean, worked: ReadonlySet<string>): RouteOption[] {
  if (!workedOnly) return [...routes];
  const kept = routes.filter((route) => worked.has(placeKey(route)));
  return kept.length > 0 ? kept : [...routes];
}
