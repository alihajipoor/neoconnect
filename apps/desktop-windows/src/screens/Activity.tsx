import { useEffect, useState } from "react";
import { BarChart3, Check, CreditCard, History, MonitorSmartphone, Wifi, X } from "lucide-react";
import type { ConnectHistory } from "../lib/connect-history";
import { loadConnectHistory } from "../lib/failover-store";
import { loadSnapshot } from "../lib/credential-cache";
import { activitySummary, networkActivity } from "../lib/activity";
import { currentNetwork } from "../lib/shell-nav";
import { useI18n } from "../lib/i18n";
import { IS_STORE_BUILD } from "../lib/distribution";
import { formatAgo, formatDate, formatNumber, formatSize, sizeParts } from "../lib/locale-format";
import { customerProtocolLabel } from "../lib/protocol-labels";
import { placeLabel, routePlace } from "../lib/route-place";
import type { RouteOption, Subscription } from "../lib/types";
import { RouteFlag } from "../components/Flag";
import { Card, CardHead, Message, NotBuiltTag, PillButton, SwitchRow } from "../components/ui";
import { Page } from "../components/shell/Page";

/** What the Activity page is drawn from: all of it this device's own, read
 * from its stores -- nothing is requested to draw it. */
export interface ActivityData {
  history: ConnectHistory;
  /** The network this device is on, or null when it cannot be told. */
  network: string | null;
  routes: RouteOption[];
  subscription: Subscription | null;
  /** When the cached plan was saved, for "as of". */
  savedAt: number | null;
}

/** The Activity page (design-system.md, phase 2): what works on this
 * network, from this device's own history; the plan as this device last
 * saw it; and, said plainly as not built, what needs engineering first --
 * the devices on the plan and daily usage need new account endpoints, and
 * a session log stays off (owner, 2026-10-19: a record of VPN use kept on a
 * device can be seen if the device is inspected).
 *
 * No live connection state here: the main page is the one place that
 * verifies the tunnel, and this page does not repeat a claim it cannot
 * check. */
export function Activity({
  readNetwork,
  readWayOut,
  onOpenPlans,
  onBack,
}: {
  /** Which network this device is on. */
  readNetwork: () => Promise<string | null>;
  /** The machine's ways out (`network_uplinks`), where they can be read:
   * whether the main page's network still holds when `readNetwork` has no
   * answer (`currentNetwork`). */
  readWayOut?: () => Promise<string | null>;
  onOpenPlans?: () => void;
  /** Outside the shell (the phone client), the way back to Settings. */
  onBack?: () => void;
}) {
  const [data, setData] = useState<ActivityData | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      loadConnectHistory().catch(() => ({}) as ConnectHistory),
      loadSnapshot().catch(() => null),
      currentNetwork(readNetwork, readWayOut),
    ]).then(([history, snapshot, network]) => {
      if (!alive) return;
      setData({
        history,
        network,
        routes: snapshot?.routes ?? [],
        subscription: snapshot?.subscription ?? null,
        savedAt: snapshot?.savedAt ?? null,
      });
    });
    return () => {
      alive = false;
    };
    // Once per visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <ActivityView data={data} onOpenPlans={onOpenPlans} onBack={onBack} />;
}

/** The page itself, from its data: separate so the dev preview can draw it
 * from samples. `now` is for the preview's fixed clock. */
export function ActivityView({
  data,
  onOpenPlans,
  onBack,
  now = Date.now(),
}: {
  data: ActivityData | null;
  onOpenPlans?: () => void;
  onBack?: () => void;
  now?: number;
}) {
  const { t, language } = useI18n();
  const n = (value: number) => formatNumber(value, language);
  const rows = data ? networkActivity(data.history, data.network, data.routes, now).slice(0, 8) : [];
  const summary = activitySummary(rows);
  const sub = data?.subscription ?? null;
  const cap = sub?.dataCapBytes ? Number(sub.dataCapBytes) : null;
  const used = sub ? Number(sub.dataUsedBytes) : 0;
  const daysLeft = sub ? Math.max(0, Math.ceil((new Date(sub.expireAt).getTime() - now) / 86_400_000)) : null;

  return (
    <Page title={t("act.title")} lede={t("act.lede")} back={onBack} data-activity>
      <div className="nx-cols">
        <Card className="flex flex-col gap-1" data-activity-network>
          <CardHead icon={<Wifi />} title={t("act.network")} hint={t("act.networkNote")} />
          {data === null ? (
            <p className="nx-wait mt-3" role="status">
              <span className="nx-spin" aria-hidden />
              {t("common.loading")}
            </p>
          ) : data.network === null ? (
            <Message tone="neutral" className="mt-3">
              {t("act.noNetwork")}
            </Message>
          ) : rows.length === 0 ? (
            <Message tone="neutral" className="mt-3">
              {t("act.nothingYet")}
            </Message>
          ) : (
            <>
              <p className="nx-tiny">{t("act.summary", { ok: n(summary.worked), n: n(summary.tried) })}</p>
              <ul className="nx-alist m-0 list-none p-0">
                {rows.map((row) => {
                  const protocol = row.route
                    ? customerProtocolLabel(row.route.protocol, row.route.transport)
                    : customerProtocolLabel(row.protocol);
                  const place = row.route ? placeLabel(row.route, language) : t("act.unlisted");
                  const where = row.route ? routePlace(row.route) : null;
                  return (
                    <li key={`${row.routeId}|${row.protocol}`} className="nx-arow">
                      {where ? (
                        <RouteFlag region={where.entry} exitRegion={where.exit} label={place} />
                      ) : (
                        <span className="nx-flagbox auto" aria-hidden>
                          <History />
                        </span>
                      )}
                      <span className="t">
                        <span className="n">
                          {place} · <bdi>{protocol}</bdi>
                        </span>
                        <span className="s">
                          {formatAgo(row.latest.at, language, now)} · {t("act.tries", { ok: n(row.worked), n: n(row.tries) })}
                        </span>
                      </span>
                      <span className={row.latest.ok ? "nx-res ok" : "nx-res"}>
                        {row.latest.ok ? <Check aria-hidden /> : <X aria-hidden />}
                        {row.latest.ok ? t("act.worked") : t("act.failed")}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </Card>

        <Card className="flex flex-col gap-1" data-activity-plan>
          <CardHead icon={<CreditCard />} title={t("act.plan")} />
          {data === null ? null : sub === null ? (
            <p className="nx-csub mt-2">{t("act.noPlan")}</p>
          ) : (
            <>
              <p className="nx-bigstat">
                {sizeParts(used, language).value}
                <small>
                  {cap !== null
                    ? `${sizeParts(used, language).unit} ${t("tr.ofCap", { cap: formatSize(cap, language) })}`
                    : `${t("tr.used", { size: sizeParts(used, language).unit })} · ${t("dash.unlimited")}`}
                </small>
              </p>
              {cap !== null ? (
                <div className="nx-bar" aria-hidden>
                  <i style={{ width: `${Math.min(100, Math.round((used / cap) * 100))}%` }} />
                </div>
              ) : null}
              <dl className="nx-kv">
                <dt>{t("plans.expires")}</dt>
                <dd>
                  {formatDate(sub.expireAt, language)}
                  {daysLeft !== null ? ` · ${t(daysLeft === 1 ? "tr.dayLeft" : "tr.daysLeft", { n: n(daysLeft) })}` : ""}
                </dd>
              </dl>
              {data.savedAt ? <p className="nx-tiny">{t("act.asOf", { when: formatAgo(data.savedAt, language, now) })}</p> : null}
            </>
          )}
          {onOpenPlans ? (
            <PillButton variant="ghost" size="sm" className="mt-3 self-start" onClick={onOpenPlans}>
              {t(IS_STORE_BUILD ? "nav.plansStore" : "nav.plans")}
            </PillButton>
          ) : null}
        </Card>

        <Card className="flex flex-col gap-1">
          <CardHead
            icon={<MonitorSmartphone />}
            title={
              <>
                {t("act.devices")} <NotBuiltTag />
              </>
            }
            hint={t("act.devicesNote")}
          />
          {sub?.deviceLimit ? <p className="nx-tiny">{t("act.deviceLimit", { n: n(sub.deviceLimit) })}</p> : null}
        </Card>

        <Card className="flex flex-col gap-1">
          <CardHead
            icon={<BarChart3 />}
            title={
              <>
                {t("act.usage")} <NotBuiltTag />
              </>
            }
            hint={t("act.usageNote")}
          />
        </Card>

        <div className="nx-group">
          <h2 className="nx-gt">{t("act.history")}</h2>
          <div className="nx-rows">
            {/* Off, and not built: a log of VPN use kept on a device can be
                seen if the device is inspected (owner, 2026-10-19). */}
            <SwitchRow icon={<History />} label={t("set.history")} hint={t("set.historyHint")} checked={false} notBuilt />
          </div>
        </div>
      </div>
    </Page>
  );
}
