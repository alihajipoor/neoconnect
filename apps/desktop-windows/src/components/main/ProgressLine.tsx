import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Play, Route, RotateCw } from "lucide-react";
import { autoReconnect, type ReconnectPhase } from "../../lib/auto-reconnect";
import { useI18n, type Language } from "../../lib/i18n";
import { ladderProgress, showsProgress, type LadderRung } from "../../lib/ladder-progress";
import { formatNumber } from "../../lib/locale-format";
import { customerProtocolLabel } from "../../lib/protocol-labels";
import { countdownLine, type CountdownLine } from "../../lib/reconnect-countdown";
import { placeLabel } from "../../lib/route-place";
import { sessionGeneration } from "../../lib/session-end";
import type { RouteOption } from "../../lib/types";

/** The line under the state while the app is getting somewhere on its own
 * (design-system.md, 4.6): why it is connecting when nobody pressed
 * ("Connect when Neoxify starts"), which rung of the ladder it is on
 * ("Trying Germany · Stealth · 3 of 8"), and an automatic reconnect's
 * attempt and countdown ("Attempt 2 of 6 · next try in 3 s").
 *
 * Its own component, so the one-second countdown re-renders this line and
 * nothing else. Facts from the pass and the episode as they run
 * (lib/ladder-progress.ts, lib/reconnect-countdown.ts), worded here. */
export function ProgressLine({ routes, autoConnecting }: { routes: readonly RouteOption[]; autoConnecting: boolean }) {
  const rung = useSyncExternalStore(ladderProgress.subscribe, ladderProgress.current, ladderProgress.current);
  const phase = useSyncExternalStore(autoReconnect.subscribe, autoReconnect.current, autoReconnect.current);
  const episode = ownEpisode(phase);
  const seen = useSeenAt(episode);
  const [now, setNow] = useState(() => performance.now());
  const counting = episode?.kind === "waiting" && episode.blockedBy === null && episode.delayMs > 0;
  useEffect(() => {
    if (!counting) return;
    setNow(performance.now());
    const id = setInterval(() => setNow(performance.now()), 1_000);
    return () => clearInterval(id);
  }, [counting, episode]);
  return (
    <ProgressLineView
      routes={routes}
      autoConnecting={autoConnecting}
      rung={rung}
      count={episode ? countdownLine(episode, seen, now) : null}
    />
  );
}

/** The line from its facts: separate so the dev preview draws exactly what
 * the main page would. */
export function ProgressLineView({
  routes,
  autoConnecting,
  rung,
  count,
}: {
  routes: readonly RouteOption[];
  autoConnecting: boolean;
  rung: LadderRung | null;
  count: CountdownLine | null;
}) {
  const { t, language } = useI18n();
  const n = (value: number) => formatNumber(value, language);
  const rungText = showsProgress(rung)
    ? t("lad.trying", { route: rungName(rung, routes, language), n: n(rung.index + 1), total: n(rung.total) })
    : null;
  const countText =
    count === null
      ? null
      : count.kind === "next"
        ? t("rc.next", { n: n(count.attempt), max: n(count.max), s: n(count.seconds) })
        : count.kind === "now"
          ? t("rc.now", { n: n(count.attempt), max: n(count.max) })
          : t("rc.attempt", { n: n(count.attempt), max: n(count.max) });

  if (countText !== null) {
    return (
      <p className="nx-subline" data-progress="reconnect">
        <RotateCw aria-hidden />
        <span>{count?.kind === "attempt" && rungText ? `${countText} · ${rungText}` : countText}</span>
      </p>
    );
  }
  if (autoConnecting) {
    return (
      <p className="nx-subline" data-progress="auto">
        <Play aria-hidden />
        <span>{rungText ? `${t("dash.autoConnecting")} ${rungText}` : t("dash.autoConnecting")}</span>
      </p>
    );
  }
  if (rungText !== null) {
    return (
      <p className="nx-subline" data-progress="ladder">
        <Route aria-hidden />
        <span>{rungText}</span>
      </p>
    );
  }
  return null;
}

/** An episode of this session's that is running, or null. */
function ownEpisode(phase: ReconnectPhase): Extract<ReconnectPhase, { kind: "waiting" | "attempting" }> | null {
  if (phase.kind !== "waiting" && phase.kind !== "attempting") return null;
  return phase.episode.session === sessionGeneration() ? phase : null;
}

/** When this wait was first seen, on the monotonic clock: a new phase
 * object is a new wait. */
function useSeenAt(phase: ReconnectPhase | null): number | null {
  const seen = useRef<{ phase: ReconnectPhase | null; at: number | null }>({ phase: null, at: null });
  if (seen.current.phase !== phase) {
    seen.current = { phase, at: phase?.kind === "waiting" ? performance.now() : null };
  }
  return seen.current.at;
}

/** "Germany · Stealth", or the protocol alone for a route not in the list. */
function rungName(rung: LadderRung, routes: readonly RouteOption[], language: Language): string {
  const protocol = customerProtocolLabel(rung.protocol, rung.transport);
  const route = routes.find((r) => r.id === rung.routeId);
  return route ? `${placeLabel(route, language)} · ${protocol}` : protocol;
}
