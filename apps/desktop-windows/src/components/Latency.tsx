import type { TranslationKey } from "../lib/i18n";
import { cn } from "../lib/utils";

/** Signal-strength bars plus the actual number.
 *
 * Both, rather than one or the other: the bars are readable at a glance
 * and mean something to anyone, while the millisecond figure is what a
 * player comparing servers actually wants. Colour follows the bars so the
 * two never disagree.
 *
 * `null` means the measurement did not complete. It renders as "--" with
 * empty bars and is never coloured, because a fabricated number here is
 * the same class of dishonesty as a false "Connected" -- someone would
 * pick a server based on it.
 */
export function Latency({ ms, className, neutral = false }: { ms: number | null; className?: string; neutral?: boolean }) {
  // Thresholds chosen for how a connection actually feels rather than
  // round numbers: under ~80ms is comfortable for real-time use, under
  // ~180ms is usable, beyond that is noticeable lag.
  const bars = ms === null ? 0 : ms < 80 ? 3 : ms < 180 ? 2 : 1;
  // Neutral in the Pearl panel: the figure says what one timing test
  // saw, not how good a server is, so it takes no traffic-light colour.
  const tone = neutral
    ? "text-ink-2"
    : ms === null
      ? "text-muted-foreground"
      : bars === 3
        ? "text-success"
        : bars === 2
          ? "text-warning"
          : "text-destructive";

  return (
    <span className={cn("flex shrink-0 items-center gap-1.5", tone, className)}>
      <span className="flex items-end gap-[2px]" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={cn(
              "w-[3px] rounded-[1px] transition-colors",
              i === 0 ? "h-[5px]" : i === 1 ? "h-[8px]" : "h-[11px]",
              i < bars ? "bg-current" : "bg-current/20",
            )}
          />
        ))}
      </span>
      {/* Kept LTR inside an RTL layout: "23 ms" must not render reversed. */}
      <span className="tabular-nums text-[11px] font-medium" data-ltr>
        {ms === null ? "--" : `${ms} ms`}
      </span>
    </span>
  );
}

/** What the redesigned list says about one timing test (design-system.md
 * 4.8), in words as well as bars, and never in a traffic-light colour: the
 * figure is how fast the entry answered one TCP connect or ping, not how
 * good a server is (`measure_latency`, src-tauri/src/vpn.rs).
 *
 * - `ms`: the figure, with three neutral bars. A relay's is the connect time
 *   to its entry in Iran only, and says so.
 * - `cant`: the test got no answer -- "Can't measure", with the reason. It
 *   never says the server is down or unreachable: networks drop pings, and
 *   a UDP port can only be pinged.
 * - `wait`: being measured now.
 * - `not`: never measured on this list. Distinct from `cant`.
 * - `offline`: the control plane reports the server down, so it was not
 *   timed at all. */
export type LatencyShown =
  | { kind: "ms"; ms: number; relay?: boolean }
  | { kind: "cant"; udp: boolean }
  | { kind: "wait" }
  | { kind: "not" }
  | { kind: "offline" };

type Say = (key: TranslationKey) => string;

export function LatencyValue({ shown, t, bars = true }: { shown: LatencyShown; t: Say; bars?: boolean }) {
  switch (shown.kind) {
    case "wait":
      return (
        <span className="nx-ms wait">
          <span aria-hidden>…</span>
          <span className="nx-sr">{t("loc.measuring")}</span>
        </span>
      );
    case "not":
      return <span className="nx-ms not">{t("loc.notMeasured")}</span>;
    case "offline":
      return (
        <span className="nx-cant off" title={t("loc.protoOfflineTip")}>
          {t("loc.evOffline")}
          <span className="nx-sr">. {t("loc.protoOfflineTip")}</span>
        </span>
      );
    case "cant": {
      const tip = t(shown.udp ? "loc.cantTipUdp" : "loc.cantTipTcp");
      return (
        <span className="nx-cant" title={tip}>
          {t("loc.cant")}
          <span className="nx-sr">. {tip}</span>
        </span>
      );
    }
    case "ms": {
      const level = shown.ms < 100 ? 3 : shown.ms < 170 ? 2 : 1;
      const figure = (
        <span className="nx-ms">
          {bars && !shown.relay ? (
            <span className="bars" aria-hidden>
              {[1, 2, 3].map((k) => (
                <i key={k} className={k <= level ? "on" : undefined} />
              ))}
            </span>
          ) : null}
          {/* Kept LTR inside an RTL layout: "23 ms" must not render reversed. */}
          <span data-ltr dir="ltr">{`${shown.ms} ms`}</span>
        </span>
      );
      if (!shown.relay) return figure;
      return (
        <span className="nx-msr" title={t("loc.toIranTip")}>
          {figure}
          <span className="msn">{t("loc.toIran")}</span>
        </span>
      );
    }
  }
}
