import { useEffect, useState, useSyncExternalStore } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useI18n, type Language, type TranslationKey } from "../../lib/i18n";
import { formatSize } from "../../lib/locale-format";
import { sparkPoints, trafficMeter, type TrafficMeter, type TrafficView } from "../../lib/traffic-meter";

/** Download and upload, as Windows counted them on the tunnel's adapter
 * (lib/traffic-meter.ts): the rate the service measured, a dash until it
 * has one, and a sparkline of the last minute. Its own small component,
 * so the once-a-second reading re-renders this and nothing else; the
 * main page only asks whether there is anything to show
 * (`useTrafficShown`). */

/** Whether the speed section exists right now. */
export function useTrafficShown(meter: TrafficMeter = trafficMeter): boolean {
  return useSyncExternalStore(meter.subscribe, () => meter.available(), () => false);
}

function useTrafficView(meter: TrafficMeter): TrafficView | null {
  const [view, setView] = useState(() => meter.view());
  useEffect(() => {
    const look = () => setView(meter.view());
    look();
    return meter.subscribe(look);
  }, [meter]);
  return view;
}

function rate(
  value: number | null,
  language: Language,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
): string {
  return value === null ? "—" : t("tr.perSec", { size: formatSize(value, language) });
}

function Spark({ series }: { series: readonly number[] }) {
  const points = sparkPoints(series, 60, 16);
  return (
    <svg className="nx-spark" viewBox="0 0 60 16" preserveAspectRatio="none" aria-hidden>
      {points ? <polyline points={points} /> : null}
    </svg>
  );
}

function Rows({ view }: { view: TrafficView }) {
  const { t, language } = useI18n();
  return (
    <>
      <span className="nx-srow">
        <ArrowDown aria-hidden />
        <span className="nx-sval" aria-label={`${t("tr.down")}: ${rate(view.rxPerSec, language, t)}`}>
          {rate(view.rxPerSec, language, t)}
        </span>
        <Spark series={view.rxSeries} />
      </span>
      <span className="nx-srow">
        <ArrowUp aria-hidden />
        <span className="nx-sval" aria-label={`${t("tr.up")}: ${rate(view.txPerSec, language, t)}`}>
          {rate(view.txPerSec, language, t)}
        </span>
        <Spark series={view.txSeries} />
      </span>
    </>
  );
}

/** The tray's fourth section. */
export function SpeedSection({ meter = trafficMeter }: { meter?: TrafficMeter }) {
  const { t } = useI18n();
  const view = useTrafficView(meter);
  if (view === null) return null;
  return (
    <div className="t nx-speed">
      <span className="nx-tlabel">{t("tr.speed")}</span>
      <Rows view={view} />
    </div>
  );
}

/** Medium and phone layouts: the same as a card. */
export function SpeedCard({ meter = trafficMeter }: { meter?: TrafficMeter }) {
  const { t } = useI18n();
  const view = useTrafficView(meter);
  if (view === null) return null;
  return (
    <div className="nx-card nx-speed wide">
      <span className="nx-tlabel">{t("tr.speed")}</span>
      <Rows view={view} />
    </div>
  );
}
