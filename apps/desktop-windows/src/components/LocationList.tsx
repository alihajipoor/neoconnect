import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Gauge, Info, Loader2, MapPin, MoreHorizontal, Search, Sparkles, TriangleAlert, X } from "lucide-react";
import { useI18n, type TranslationKey } from "../lib/i18n";
import { formatAgo, formatNumber } from "../lib/locale-format";
import { bestLatency, buildList, listEmpty, listKey, routeWorked, rowEvidence, udpOnly, type ListFilter, type ListPlace } from "../lib/location-list";
import type { PlaceEvidence } from "../lib/map-lights";
import { customerProtocolLabel } from "../lib/protocol-labels";
import { countryCode, placeLabel, routePlace } from "../lib/route-place";
import type { Protocol, RouteOption } from "../lib/types";
import { cn } from "../lib/utils";
import { IspTagLine } from "./IspTagLine";
import { LatencyValue, type LatencyShown } from "./Latency";
import { RouteFlag } from "./Flag";
import { MapLegend } from "./main/MapLegend";
import { Menu } from "./overlay";
import { Card, PillButton, Segmented, Tag } from "./ui";

/** What the main page's map lights are made of (`lib/map-lights.ts`), so
 * the list says the same as the map: its "Worked here" filter keeps the
 * places whose light twinkles, and a row says why. */
export interface ListEvidence {
  /** Places (`placeKey`) with evidence that they worked on this network. */
  worked: ReadonlySet<string>;
  /** When a route last carried traffic from this device on this network,
   * or null. */
  ownAt: (route: RouteOption) => number | null;
  /** Whether the list's per-network tags describe the network the device
   * is on now: not after a roam, until a list asked for since arrives. */
  tags: boolean;
  /** What each place's light says (`placesEvidence`, keyed by `placeKey`):
   * a country row's words. Absent, the rows say only how many protocols. */
  places?: ReadonlyMap<string, PlaceEvidence>;
}

export type ListVariant = "panel" | "sheet" | "page";

/** The plain-language line for each protocol (`CUSTOMER_PROTOCOL_HINTS`),
 * in both languages. */
const HINTS: Record<Protocol, TranslationKey> = {
  XRAY_VLESS_REALITY: "proto.hint.reality",
  XRAY_VLESS_TLS: "proto.hint.tls",
  XRAY_VMESS: "proto.hint.vmess",
  XRAY_TROJAN: "proto.hint.trojan",
  SHADOWSOCKS: "proto.hint.ss",
  WIREGUARD: "proto.hint.wg",
  OPENVPN: "proto.hint.ovpn",
  IKEV2: "proto.hint.ikev2",
};

export function protocolHintKey(route: Pick<RouteOption, "protocol" | "transport">): TranslationKey {
  if (route.protocol === "XRAY_VLESS_TLS" && route.transport === "WS") return "proto.hint.ws";
  return HINTS[route.protocol];
}

const protocolOf = (route: Pick<RouteOption, "protocol" | "transport">) => customerProtocolLabel(route.protocol, route.transport);

/** Rings a place's light on the main page's map while its row is hovered
 * or focused (design-system.md 5.3). A mark on the light's own element:
 * the map is decoration, and this changes nothing it says. */
function ringLight(cc: string | null) {
  if (typeof document === "undefined") return;
  for (const lamp of document.querySelectorAll(".nx-lamp[data-ring]")) lamp.removeAttribute("data-ring");
  if (cc && /^[a-z]{2}$/.test(cc)) document.querySelector(`.nx-lamp[data-cc="${cc}"]`)?.setAttribute("data-ring", "1");
}

/** The country a place's light stands on: its own, and Iran -- the entry --
 * for every route through Iran. */
function lightOf(place: ListPlace): string | null {
  return countryCode(routePlace(place.routes[0]).entry);
}

/** The redesigned server list (design-system.md 4.8): search, a filter that
 * never wraps, then Automatic, the countries and the routes through Iran,
 * each country opening to every protocol it has. The same list in three
 * frames: the locations panel beside the hero (`panel`), the phone's sheet
 * (`sheet`), and the Locations page (`page`), which adds each protocol's
 * plain-language hint, the full sentence of what others saw, and the cards
 * that explain the protocols and the evidence.
 *
 * Presentation only. What a pick does, when the list is fetched and when
 * latency is measured are the picker's (`LocationPicker`), which passes its
 * own loading and error states in as `status` and its switch's lines as
 * `after`. */
export function LocationList({
  variant,
  routes,
  latencies,
  measuring,
  measuredAt,
  tunnelActive,
  connectionState,
  pinnedRouteId,
  currentRouteId,
  automatic,
  showAutomatic,
  switchingId,
  evidence,
  onPick,
  onAutomatic,
  onMeasure,
  onOpenFull,
  focusSection,
  status,
  after,
}: {
  variant: ListVariant;
  routes: RouteOption[];
  latencies: Readonly<Record<string, number | null>>;
  measuring: boolean;
  measuredAt: number | null;
  tunnelActive: boolean;
  connectionState?: string;
  /** The route chosen by the customer: the selected row. */
  pinnedRouteId?: string;
  /** The route the screen names (the tunnel's once one is up): its place is
   * never said to be failing, as its light is never drawn hollow. */
  currentRouteId?: string;
  automatic: boolean;
  showAutomatic: boolean;
  switchingId: string | null;
  evidence?: ListEvidence;
  onPick: (route: RouteOption) => void;
  onAutomatic: () => void;
  onMeasure: () => void;
  /** The Locations page, from the panel's menu. */
  onOpenFull?: (section?: "explain") => void;
  /** The page opened at a section. */
  focusSection?: "explain";
  /** Loading, an error, or a plan with nothing on it: shown in place of the
   * rows, without the search and the filter. */
  status?: ReactNode;
  after?: ReactNode;
}) {
  const { t, language } = useI18n();
  const page = variant === "page";
  const quick = !page;
  /** Whether a protocol's "Can't measure" says why on its row (above). */
  const cantSaid = variant !== "panel";
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ListFilter>("all");
  /** Opened or closed by the customer; otherwise a place is open only when a
   * search matched it by a protocol. Countries start closed. */
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const searchRef = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const headId = useId();
  const explainId = useId();
  const rtl = language === "fa";

  // A place the customer closed opens again for the next search that finds
  // it by a protocol.
  useEffect(() => {
    setOpened((prev) => (prev.size === 0 ? prev : new Map([...prev].filter(([, open]) => open))));
  }, [query]);

  // The page opened at its explanation of the protocols.
  useEffect(() => {
    if (focusSection !== "explain") return;
    const heading = document.getElementById(explainId);
    heading?.scrollIntoView({ block: "start" });
    heading?.focus({ preventScroll: true });
  }, [focusSection, explainId]);

  useEffect(() => () => ringLight(null), []);

  const worked = (route: RouteOption) =>
    evidence ? routeWorked(route, evidence) : route.nodeStatus === "ONLINE" && route.ispTag?.code === "worksOnYourIsp";
  const hasRelays = routes.some((route) => route.isRelay);
  const shownFilter: ListFilter = filter === "relay" && !hasRelays ? "all" : filter;
  const model = buildList(routes, {
    query,
    filter: shownFilter,
    worked,
    automaticTerms: [t("loc.automaticShort"), "Automatic", "خودکار"],
  });
  const withAutomatic = model.automatic && showAutomatic;
  const empty = listEmpty({ ...model, automatic: withAutomatic });
  const isOpen = (place: ListPlace) => opened.get(place.key) ?? place.open;
  const setOpen = (key: string, open: boolean) => setOpened((prev) => new Map(prev).set(key, open));

  // The rows in the order they are drawn, for the keys that move between
  // them: a closed country's protocols are not among them.
  const visible: string[] = [];
  if (withAutomatic) visible.push("auto");
  for (const place of [...model.countries, ...model.relays]) {
    visible.push(`p:${place.key}`);
    if (isOpen(place)) for (const route of place.shown) visible.push(`r:${route.id}`);
  }
  const pinned = pinnedRouteId ? routes.find((route) => route.id === pinnedRouteId) : undefined;
  const selectedKey = automatic
    ? "auto"
    : pinned
      ? visible.includes(`r:${pinned.id}`)
        ? `r:${pinned.id}`
        : `p:${listKey(pinned)}`
      : null;
  // One tab stop for the whole list: the row last focused, else the
  // selected one, else the first.
  const stop =
    focusKey && visible.includes(focusKey) ? focusKey : selectedKey && visible.includes(selectedKey) ? selectedKey : visible[0];

  function focusRow(key: string | undefined) {
    if (!key) return;
    setFocusKey(key);
    rowRefs.current.get(key)?.focus();
  }

  function onListKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-row]");
    const key = row?.dataset.row;
    if (!key) return;
    const at = visible.indexOf(key);
    const go = (next: string | undefined) => {
      event.preventDefault();
      focusRow(next);
    };
    switch (event.key) {
      case "ArrowDown":
        go(visible[Math.min(visible.length - 1, at + 1)]);
        return;
      case "ArrowUp":
        if (at <= 0) {
          event.preventDefault();
          searchRef.current?.focus();
        } else go(visible[at - 1]);
        return;
      case "Home":
        go(visible[0]);
        return;
      case "End":
        go(visible[visible.length - 1]);
        return;
      case "ArrowRight":
      case "ArrowLeft": {
        // Right opens a country and Left closes it, mirrored in Persian;
        // towards the start from a protocol goes back to its country.
        const forward = (event.key === "ArrowRight") !== rtl;
        if (key.startsWith("p:")) {
          const place = [...model.countries, ...model.relays].find((p) => `p:${p.key}` === key);
          if (!place) return;
          const open = isOpen(place);
          event.preventDefault();
          if (forward && !open) setOpen(place.key, true);
          else if (!forward && open) setOpen(place.key, false);
          else if (forward && open) focusRow(`r:${place.shown[0]?.id}`);
        } else if (key.startsWith("r:") && !forward) {
          const route = routes.find((r) => `r:${r.id}` === key);
          if (route) go(`p:${listKey(route)}`);
        }
        return;
      }
    }
  }

  const rowProps = (key: string) => ({
    "data-row": key,
    ref: (el: HTMLButtonElement | null) => {
      if (el) rowRefs.current.set(key, el);
      else rowRefs.current.delete(key);
    },
    tabIndex: key === stop ? 0 : -1,
    onFocus: () => setFocusKey(key),
  });

  /** "Connected here" only over verified traffic; "In use" over a tunnel
   * that is up and not proven. */
  const hereWord = (route: RouteOption): string | null =>
    route.id !== pinnedRouteId
      ? null
      : connectionState === "connected"
        ? t("loc.connectedHere")
        : connectionState === "unverified" || connectionState === "degraded"
          ? t("loc.inUse")
          : null;

  function latencyOf(route: RouteOption): LatencyShown | null {
    // Nothing is measurable from inside a tunnel (see the picker's
    // `tunnelActive`): no figure rather than a stale one.
    if (tunnelActive) return null;
    if (route.nodeStatus !== "ONLINE") return { kind: "offline" };
    if (route.id in latencies) {
      const ms = latencies[route.id];
      return ms === null ? { kind: "cant", udp: udpOnly(route) } : { kind: "ms", ms, relay: route.isRelay };
    }
    return measuring ? { kind: "wait" } : { kind: "not" };
  }

  function ownTip(route: RouteOption, at: number): string {
    return t("loc.evOwnTip", { p: protocolOf(route), when: formatAgo(at, language) });
  }

  /** What a country row says under its name: the light's words. */
  function placeWords(place: ListPlace): ReactNode {
    const holds = pinned && place.routes.some((route) => route.id === pinned.id);
    if (holds && pinned) {
      const here = hereWord(pinned);
      // The words the selected protocol row says, or its name: the row is
      // narrow, and the protocol is one press away.
      return (
        <span className="nx-pick" title={here ? `${here} · ${protocolOf(pinned)}` : undefined}>
          {here ?? protocolOf(pinned)}
        </span>
      );
    }
    let said: PlaceEvidence | null = evidence?.places ? rowEvidence(place, evidence.places) : null;
    // The place a tunnel is up on is never said to be failing: its light is
    // never drawn hollow either.
    if (said?.look === "down" && tunnelActive && place.routes.some((route) => route.id === currentRouteId)) said = null;
    const count = new Set(place.routes.map(protocolOf)).size;
    const protocols = t(count === 1 ? "loc.protocolsOne" : "loc.protocols", { n: formatNumber(count, language) });
    switch (said?.why) {
      case "own": {
        const route = place.routes.find((r) => r.protocol === said.protocol) ?? place.routes[0];
        const tip = said.at !== undefined ? ownTip(route, said.at) : t("loc.ownWorkedTip");
        return (
          <span className="nx-ev ok" title={tip}>
            <Check aria-hidden />
            {t("map.live")}
            <span className="nx-sr">. {tip}</span>
          </span>
        );
      }
      case "isp":
        return (
          <span className="nx-ev ok" title={t("loc.ispWorks")}>
            <Check aria-hidden />
            {t("map.live")}
            <span className="nx-sr">. {t("loc.ispWorks")}</span>
          </span>
        );
      case "ispFail":
        return (
          <span className="nx-ev warn" title={t("loc.ispFailing")}>
            <TriangleAlert aria-hidden />
            {t("loc.evIspFail")}
            <span className="nx-sr">. {t("loc.ispFailing")}</span>
          </span>
        );
      case "offline":
        return (
          <span className="nx-ev off" title={t("loc.evOfflineTip")}>
            <Info aria-hidden />
            {t("loc.evOffline")}
            <span className="nx-sr">. {t("loc.evOfflineTip")}</span>
          </span>
        );
      default:
        return <span>{protocols}</span>;
    }
  }

  function placeLatency(place: ListPlace): ReactNode {
    if (tunnelActive) return null;
    const best = bestLatency(place, latencies);
    if (best !== null) return <LatencyValue shown={{ kind: "ms", ms: best, relay: place.relay }} t={t} bars={false} />;
    return measuring ? <LatencyValue shown={{ kind: "wait" }} t={t} /> : null;
  }

  function protocolRow(place: ListPlace, route: RouteOption) {
    const key = `r:${route.id}`;
    const selected = route.id === pinnedRouteId;
    const label = protocolOf(route);
    // The node's name only where two rows would otherwise read the same --
    // one place, one protocol, two nodes. It is an internal name.
    const twin = place.routes.some((r) => r.id !== route.id && protocolOf(r) === label);
    const ownAt = evidence ? evidence.ownAt(route) : null;
    const tagsShown = !evidence || evidence.tags;
    const here = hereWord(route);
    const latency = latencyOf(route);
    return (
      <button
        key={key}
        type="button"
        {...rowProps(key)}
        className={cn("nx-row nx-prow", selected && "sel")}
        aria-pressed={selected}
        aria-disabled={switchingId !== null || undefined}
        onClick={() => onPick(route)}
      >
        <span className="t">
          <span className="n">
            <bdi>{label}</bdi>
            {twin ? <span className="nx-node"> · {route.location.nodeName}</span> : null}
            {quick ? (
              ownAt !== null ? (
                <span className="nx-ispi" role="img" data-own-worked="" title={ownTip(route, ownAt)} aria-label={ownTip(route, ownAt)}>
                  <Check aria-hidden />
                </span>
              ) : tagsShown ? (
                <IspTagLine tag={route.ispTag} t={t} look="icon" language={language} />
              ) : null
            ) : null}
          </span>
          {page ? <span className="s wrap">{t(protocolHintKey(route))}</span> : null}
          {page ? (
            ownAt !== null ? (
              <span className="nx-ev ok" data-own-worked="">
                <Check aria-hidden />
                <span>{ownTip(route, ownAt)}</span>
              </span>
            ) : tagsShown ? (
              <IspTagLine tag={route.ispTag} t={t} language={language} />
            ) : null
          ) : null}
          {here ? <span className={cn("nx-inuse", connectionState === "connected" && "ok")}>{here}</span> : null}
          {/* Why it could not be timed, on the row where a touch has no
              hover to find it: the whole reason on the page, the short one
              in the phone's sheet. The panel keeps it as a tooltip. */}
          {cantSaid && latency?.kind === "cant" ? (
            <span className="s wrap nx-cantwhy">
              {t(page ? (latency.udp ? "loc.cantTipUdp" : "loc.cantTipTcp") : latency.udp ? "loc.cantWhyUdp" : "loc.cantWhyTcp")}
            </span>
          ) : null}
        </span>
        <span className="end">
          {latency ? <LatencyValue shown={latency} t={t} explained={cantSaid} /> : null}
          {switchingId === route.id ? (
            <Loader2 className="nx-spinning size-4" aria-hidden />
          ) : selected ? (
            <Check className="nx-tick size-4" aria-hidden />
          ) : null}
        </span>
      </button>
    );
  }

  function placeRows(place: ListPlace) {
    const key = `p:${place.key}`;
    const open = isOpen(place);
    const first = place.routes[0];
    const where = routePlace(first);
    const name = placeLabel(first, language);
    const holds = pinned !== undefined && place.routes.some((route) => route.id === pinned.id);
    const accId = `${headId}-${place.key.replace(/[^a-z0-9]/gi, "")}`;
    const light = lightOf(place);
    return (
      <div key={place.key} className="nx-place">
        <button
          type="button"
          {...rowProps(key)}
          className={cn("nx-row nx-crow", holds && !open && "sel")}
          aria-expanded={open}
          aria-controls={accId}
          onClick={() => setOpen(place.key, !open)}
          onPointerEnter={() => ringLight(light)}
          onPointerLeave={() => ringLight(null)}
          onFocusCapture={() => ringLight(light)}
          onBlur={() => ringLight(null)}
        >
          <span className="nx-flag">
            <RouteFlag region={where.entry} exitRegion={where.exit} label={name} size="row" />
          </span>
          <span className="t">
            <span className="n">{name}</span>
            <span className="s">
              {place.relay ? <span className="nx-rpill">{t("loc.relayPill")}</span> : null}
              {placeWords(place)}
            </span>
          </span>
          <span className="end">
            {placeLatency(place)}
            {holds && !open ? <Check className="nx-tick size-4" aria-hidden /> : null}
            <ChevronDown className="chev" aria-hidden />
          </span>
        </button>
        <div className={cn("nx-acc", open && "open")} id={accId}>
          <div inert={!open ? true : undefined}>{place.shown.map((route) => protocolRow(place, route))}</div>
        </div>
      </div>
    );
  }

  const automaticRow = withAutomatic ? (
    <button
      type="button"
      {...rowProps("auto")}
      className={cn("nx-row", automatic && "sel")}
      aria-pressed={automatic}
      aria-disabled={switchingId !== null || undefined}
      onClick={onAutomatic}
    >
      <span className="nx-flag auto" aria-hidden>
        <Sparkles className="size-4" />
      </span>
      <span className="t">
        <span className="n">
          {t("loc.automaticShort")} <Tag>{t("loc.recommended")}</Tag>
        </span>
        <span className={cn("s", page && "wrap")} title={quick ? t("loc.automaticHint") : undefined}>
          {t(quick ? "loc.automaticHintShort" : "loc.automaticHint")}
        </span>
      </span>
      <span className="end">{automatic ? <Check className="nx-tick size-4" aria-hidden /> : null}</span>
    </button>
  ) : null;

  const reset = () => {
    setQuery("");
    setFilter("all");
    searchRef.current?.focus();
  };

  const foot = tunnelActive
    ? t("loc.pausedNote")
    : measuring
      ? t("loc.measuring")
      : measuredAt !== null
        ? t("loc.measuredAt", { when: formatAgo(measuredAt, language) })
        : t("loc.notMeasuredNote");

  const rows = empty ? (
    <div className="nx-lempty" role="status">
      <Search aria-hidden />
      <b>
        {query.trim()
          ? t("loc.empty", { q: query.trim() })
          : shownFilter === "worked"
            ? t("loc.emptyWorked")
            : t("loc.emptyRelay")}
      </b>
      {query.trim() ? <span>{t("loc.emptyHint")}</span> : null}
      <PillButton variant="ghost" size="sm" onClick={reset}>
        {t("loc.showAll")}
      </PillButton>
    </div>
  ) : (
    <>
      {automaticRow}
      {model.countries.length > 0 ? <h3 className="nx-lgrp">{t("loc.countries")}</h3> : null}
      {model.countries.map(placeRows)}
      {model.relays.length > 0 ? (
        <>
          <h3 className="nx-lgrp">{t("loc.backup")}</h3>
          {page ? <p className="nx-lgrph">{t("loc.backupHint")}</p> : null}
        </>
      ) : null}
      {model.relays.map(placeRows)}
      <p className="nx-lfoot">
        <Info aria-hidden />
        <span>{foot}</span>
        {!tunnelActive && !measuring && !page ? (
          <button type="button" className="nx-lnk" onClick={onMeasure}>
            {t(measuredAt !== null ? "loc.measureAgain" : "loc.measure")}
          </button>
        ) : null}
      </p>
    </>
  );

  const search = (
    <div className="nx-search">
      <Search className="i" aria-hidden />
      <input
        ref={searchRef}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            focusRow(visible[0]);
          } else if (event.key === "Escape" && query) {
            // Clears the search first; a second Escape closes the sheet.
            event.preventDefault();
            event.stopPropagation();
            setQuery("");
          }
        }}
        placeholder={t("loc.search")}
        aria-label={t("loc.search")}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        data-autofocus={variant === "sheet" ? "" : undefined}
      />
      {query ? (
        <button
          type="button"
          className="clr"
          aria-label={t("loc.clear")}
          title={t("loc.clear")}
          onClick={() => {
            setQuery("");
            searchRef.current?.focus();
          }}
        >
          <X aria-hidden />
        </button>
      ) : null}
    </div>
  );

  const filters = (
    <div className="nx-locs-filter">
      <Segmented
        size="sm"
        label={t("loc.filters")}
        value={shownFilter}
        onChange={setFilter}
        options={[
          { value: "all", label: t("loc.fAll") },
          { value: "worked", label: t("loc.fWorked"), long: t("loc.fWorkedLong") },
          ...(hasRelays ? [{ value: "relay" as const, label: t("loc.fRelay"), long: t("loc.fRelayLong") }] : []),
        ]}
      />
    </div>
  );

  const list = (
    <div
      className={cn("nx-loclist", page && "page")}
      role="group"
      aria-labelledby={variant === "panel" ? headId : undefined}
      aria-label={variant === "panel" ? undefined : t("loc.panelTitle")}
      onKeyDown={onListKeyDown}
    >
      {status ?? rows}
    </div>
  );

  if (page) {
    // Every protocol on the plan, once, in list order: none left out.
    const protocols: RouteOption[] = [];
    for (const route of routes) if (!protocols.some((p) => protocolOf(p) === protocolOf(route))) protocols.push(route);
    return (
      <div className="nx-locpage">
        <Card className="nx-loccard">
          {status ? null : search}
          {status ? null : filters}
          {list}
          {after}
        </Card>
        <div className="nx-locside">
          <Card>
            <h2 className="nx-ctitle" id={explainId} tabIndex={-1}>
              {t("loc.explain")}
            </h2>
            <p className="nx-csub">{t("loc.explainLede")}</p>
            <dl className="nx-protolist">
              {protocols.map((route) => (
                <div key={protocolOf(route)}>
                  <dt>
                    <bdi>{protocolOf(route)}</bdi>
                  </dt>
                  <dd>{t(protocolHintKey(route))}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <Card>
            <h2 className="nx-ctitle">{t("loc.worked")}</h2>
            <p className="nx-csub">{t("loc.ispNote")}</p>
            {evidence ? <MapLegend /> : null}
            <PillButton
              variant="ghost"
              size="sm"
              className="nx-measure"
              aria-disabled={tunnelActive || measuring || undefined}
              onClick={() => {
                if (!tunnelActive && !measuring) onMeasure();
              }}
            >
              <Gauge aria-hidden />
              {t(measuredAt !== null ? "loc.measureAgain" : "loc.measure")}
            </PillButton>
            {tunnelActive ? <p className="nx-tiny">{t("loc.measureOff")}</p> : null}
          </Card>
        </div>
      </div>
    );
  }

  if (variant === "sheet") {
    return (
      <div className="nx-locbody">
        {status ? null : search}
        {status ? null : filters}
        {list}
        {after}
        {evidence && !status ? <MapLegend /> : null}
      </div>
    );
  }

  return (
    <>
      <div className="nx-locs-head">
        <h2 id={headId}>{t("loc.panelTitle")}</h2>
        <button
          ref={moreRef}
          type="button"
          className="nx-ibtn sm"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t("loc.more")}
          title={t("loc.more")}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <MoreHorizontal aria-hidden />
        </button>
      </div>
      <Menu open={menuOpen} anchor={moreRef} onClose={() => setMenuOpen(false)} label={t("loc.more")} placement="below" align="end">
        <button
          type="button"
          role="menuitem"
          aria-disabled={tunnelActive || measuring || routes.length === 0 || undefined}
          onClick={() => {
            if (tunnelActive || measuring || routes.length === 0) return;
            setMenuOpen(false);
            onMeasure();
          }}
        >
          <Gauge aria-hidden />
          {t(measuredAt !== null ? "loc.measureAgain" : "loc.measure")}
        </button>
        {tunnelActive ? <p className="mi-s">{t("loc.measureOff")}</p> : null}
        {onOpenFull ? (
          <>
            <hr />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onOpenFull("explain");
              }}
            >
              <Info aria-hidden />
              {t("loc.explain")}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onOpenFull();
              }}
            >
              <MapPin aria-hidden />
              {t("loc.openFull")}
            </button>
          </>
        ) : null}
      </Menu>
      {status ? null : search}
      {status ? null : filters}
      {list}
      {after}
    </>
  );
}
