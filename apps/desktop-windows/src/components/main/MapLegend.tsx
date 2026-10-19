import { useI18n } from "../../lib/i18n";

/** What the world map's lights mean, in words: the map itself is
 * `aria-hidden`, so this is where its meaning lives. Four shapes, never
 * colour alone: twinkling, steady, hollow, large. The full sentence of each
 * is its tooltip. */
export function MapLegend() {
  const { t } = useI18n();
  return (
    <div className="nx-mlegend" role="note" aria-label={t("map.legend")}>
      <span title={t("map.liveTip")}>
        <i className="nx-lk live" aria-hidden />
        {t("map.live")}
      </span>
      <span title={t("map.idleTip")}>
        <i className="nx-lk idle" aria-hidden />
        {t("map.idle")}
      </span>
      <span title={t("map.downTip")}>
        <i className="nx-lk down" aria-hidden />
        {t("map.down")}
      </span>
      <span title={t("map.hereTip")}>
        <i className="nx-lk here" aria-hidden />
        {t("loc.connectedHere")}
      </span>
    </div>
  );
}
