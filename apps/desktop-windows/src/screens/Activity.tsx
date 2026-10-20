import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BarChart3, Check, CreditCard, History, LogOut, Monitor, MonitorSmartphone, Smartphone, Trash2, Wifi, X } from "lucide-react";
import type { ConnectHistory } from "../lib/connect-history";
import { loadConnectHistory } from "../lib/failover-store";
import { loadSnapshot } from "../lib/credential-cache";
import { activitySummary, networkActivity } from "../lib/activity";
import { currentNetwork } from "../lib/shell-nav";
import { useI18n, type Language, type TranslationKey } from "../lib/i18n";
import { IS_STORE_BUILD } from "../lib/distribution";
import {
  formatAgo,
  formatDate,
  formatDay,
  formatDuration,
  formatNumber,
  formatSize,
  formatTime,
  sizeParts,
} from "../lib/locale-format";
import { customerProtocolLabel } from "../lib/protocol-labels";
import { placeLabel, routePlace } from "../lib/route-place";
import type { RouteOption, Subscription } from "../lib/types";
import { getDailyUsage, getDevices, signOutDevice, type AccountDevice, type AccountDevices, type DailyUsage } from "../lib/customer";
import {
  deviceKind,
  deviceSignOutOutcome,
  deviceTimeZone,
  loadableFrom,
  USAGE_DAYS,
  usageChart,
  usageLoadable,
  type DeviceSignOutOutcome,
  type Loadable,
} from "../lib/account-activity";
import { parseDevicePlatform, specificDeviceLabel } from "../lib/device-identity";
import { sessionLog, type SessionRecord } from "../lib/session-log";
import { Card, CardHead, Message, PillButton, Row, SwitchRow } from "../components/ui";
import { Dialog } from "../components/overlay";
import { RouteFlag } from "../components/Flag";
import { Page } from "../components/shell/Page";

/** What the Activity page is drawn from: this device's own history and
 * the plan as this device last saw it, read from its stores. */
export interface ActivityData {
  history: ConnectHistory;
  /** The network this device is on, or null when it cannot be told. */
  network: string | null;
  routes: RouteOption[];
  subscription: Subscription | null;
  /** When the cached plan was saved, for "as of". */
  savedAt: number | null;
}

/** The session log as the page shows it (lib/session-log.ts), on a
 * platform that records one. */
export interface SessionLogView {
  enabled: boolean;
  loaded: boolean;
  records: readonly SessionRecord[];
  onEnabled: (enabled: boolean) => void;
  onClear: () => void;
}

/** The Activity page (design-system.md, phase 2): what works on this
 * network, from this device's own history; the plan as this device last
 * saw it; the devices signed in to the account and its daily usage, from
 * the account (docs/account-activity.md); and, where the platform records
 * one and the customer has turned it on, the session log -- off by
 * default, on this device only, seven days (owner, 2026-10-19).
 *
 * No live connection state here: the main page is the one place that
 * verifies the tunnel, and this page does not repeat a claim it cannot
 * check. */
export function Activity({
  readNetwork,
  readWayOut,
  onOpenPlans,
  onBack,
  sessionLog: logRecorded = false,
  deviceSignOut = false,
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
  /** This platform's main page records the session log, so its switch is
   * offered. Windows does; a phone does once its main page does. */
  sessionLog?: boolean;
  /** Offer "Sign out" on the account's other devices. Off until the owner
   * approves it (docs/account-activity.md: no client exposes it before);
   * built, so approving it is this one prop. */
  deviceSignOut?: boolean;
}) {
  const [data, setData] = useState<ActivityData | null>(null);
  const [devices, setDevices] = useState<Loadable<AccountDevices>>({ state: "loading" });
  const [usage, setUsage] = useState<Loadable<DailyUsage>>({ state: "loading" });
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void Promise.all([
      loadConnectHistory().catch(() => ({}) as ConnectHistory),
      loadSnapshot().catch(() => null),
      currentNetwork(readNetwork, readWayOut),
    ]).then(([history, snapshot, network]) => {
      if (!alive.current) return;
      setData({
        history,
        network,
        routes: snapshot?.routes ?? [],
        subscription: snapshot?.subscription ?? null,
        savedAt: snapshot?.savedAt ?? null,
      });
    });
    return () => {
      alive.current = false;
    };
    // Once per visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadDevices = useCallback(() => {
    setDevices({ state: "loading" });
    void getDevices().then((result) => alive.current && setDevices(loadableFrom(result)));
  }, []);
  const loadUsage = useCallback(() => {
    setUsage({ state: "loading" });
    void readUsage().then((result) => alive.current && setUsage(result));
  }, []);
  useEffect(() => {
    loadDevices();
    loadUsage();
  }, [loadDevices, loadUsage]);

  const log = useSessionLog(logRecorded);

  const signOut = useCallback(
    async (device: AccountDevice): Promise<DeviceSignOutOutcome> => {
      const outcome = deviceSignOutOutcome(await signOutDevice(device.id));
      // Signed out, or already gone: the list as the account has it now.
      if (alive.current && (outcome === "done" || outcome === "alreadyGone")) loadDevices();
      return outcome;
    },
    [loadDevices],
  );

  return (
    <ActivityView
      data={data}
      devices={devices}
      usage={usage}
      log={log}
      onSignOutDevice={deviceSignOut ? signOut : undefined}
      onRetryDevices={loadDevices}
      onRetryUsage={loadUsage}
      onOpenPlans={onOpenPlans}
      onBack={onBack}
    />
  );
}

/** The daily usage, in the device's own days. A zone the server does not
 * know is asked again in UTC, and the card says the days are UTC's. */
async function readUsage(): Promise<Loadable<DailyUsage>> {
  const zone = deviceTimeZone();
  let result = await getDailyUsage(USAGE_DAYS, zone);
  if (!result.ok && result.code === "UNKNOWN_TIME_ZONE" && zone !== "UTC") result = await getDailyUsage(USAGE_DAYS, "UTC");
  return usageLoadable(result);
}

/** The session log, where this platform records it. */
function useSessionLog(recorded: boolean): SessionLogView | undefined {
  const state = useSyncExternalStore(sessionLog.subscribe, sessionLog.current, sessionLog.current);
  const [loaded, setLoaded] = useState(sessionLog.loaded());
  useEffect(() => {
    if (!recorded) return;
    let alive = true;
    void sessionLog.load().then(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [recorded]);
  if (!recorded) return undefined;
  return {
    enabled: state.enabled,
    loaded,
    records: state.records,
    onEnabled: (enabled) => void sessionLog.setEnabled(enabled),
    onClear: () => void sessionLog.clear(),
  };
}

/** The page itself, from its data: separate so the dev preview can draw it
 * from samples. `now` is for the preview's fixed clock. */
export function ActivityView({
  data,
  devices = { state: "loading" },
  usage = { state: "loading" },
  log,
  onSignOutDevice,
  onRetryDevices,
  onRetryUsage,
  onOpenPlans,
  onBack,
  now = Date.now(),
}: {
  data: ActivityData | null;
  devices?: Loadable<AccountDevices>;
  usage?: Loadable<DailyUsage>;
  log?: SessionLogView;
  /** Signs another device out; absent, no row offers it. */
  onSignOutDevice?: (device: AccountDevice) => Promise<DeviceSignOutOutcome>;
  onRetryDevices?: () => void;
  onRetryUsage?: () => void;
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
  const [signingOut, setSigningOut] = useState<AccountDevice | null>(null);

  return (
    <Page title={t("act.title")} lede={t("act.lede")} back={onBack} data-activity>
      <div className="nx-cols">
        <Card className="flex flex-col gap-1" data-activity-network>
          <CardHead icon={<Wifi />} title={t("act.network")} hint={t("act.networkNote")} />
          {data === null ? (
            <Waiting />
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

        <Card className="flex flex-col gap-1" data-activity-devices>
          <CardHead icon={<MonitorSmartphone />} title={t("act.devices")} hint={t("act.devicesNote")} />
          {devices.state === "loading" ? (
            <Waiting />
          ) : devices.state === "failed" ? (
            <Unread text={t(devices.noAnswer ? "act.devicesNoAnswer" : "act.devicesFailed")} onRetry={onRetryDevices} />
          ) : (
            <>
              <ul className="nx-alist m-0 list-none p-0">
                {devices.data.devices.map((device) => (
                  <DeviceRow
                    key={device.id}
                    device={device}
                    now={now}
                    // Never this device: that is the app's own sign-out.
                    onSignOut={onSignOutDevice && !device.thisDevice ? () => setSigningOut(device) : undefined}
                  />
                ))}
              </ul>
              {!devices.data.inUseKnown ? <p className="nx-tiny">{t("act.inUseUnknown")}</p> : null}
            </>
          )}
          {sub?.deviceLimit ? <p className="nx-tiny">{t("act.deviceLimit", { n: n(sub.deviceLimit) })}</p> : null}
        </Card>

        <Card className="flex flex-col gap-1" data-activity-usage>
          <CardHead icon={<BarChart3 />} title={t("act.usage")} hint={t("act.usageNote")} />
          {usage.state === "loading" ? (
            <Waiting />
          ) : usage.state === "failed" ? (
            <Unread text={t(usage.noAnswer ? "act.usageNoAnswer" : "act.usageFailed")} onRetry={onRetryUsage} />
          ) : (
            <UsageBody usage={usage.data} now={now} />
          )}
        </Card>

        {log ? <SessionLogGroup log={log} routes={data?.routes ?? []} /> : null}
      </div>
      {onSignOutDevice ? (
        <DeviceSignOutDialog device={signingOut} onSignOut={onSignOutDevice} onClose={() => setSigningOut(null)} />
      ) : null}
    </Page>
  );
}

/** "Sign out" for another of the account's devices: what it does, asked
 * once, and what came of it said -- never a silent failure. */
function DeviceSignOutDialog({
  device,
  onSignOut,
  onClose,
}: {
  device: AccountDevice | null;
  onSignOut: (device: AccountDevice) => Promise<DeviceSignOutOutcome>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<TranslationKey | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const name = device ? deviceListName(device, t) : "";
  const close = () => {
    if (busy) return;
    setProblem(null);
    onClose();
  };
  async function go() {
    if (!device || busy) return;
    setBusy(true);
    setProblem(null);
    const outcome = await onSignOut(device);
    setBusy(false);
    if (outcome === "done" || outcome === "alreadyGone") {
      onClose();
      return;
    }
    setProblem(outcome === "unreached" ? "act.signOutUnreached" : "act.signOutFailed");
  }
  return (
    <Dialog
      open={device !== null}
      title={t("act.signOutTitle", { device: name })}
      description={t("act.signOutBody")}
      onClose={close}
      initialFocus={keepRef}
      actions={
        <>
          <PillButton ref={keepRef} variant="ghost" size="sm" onClick={close} disabled={busy}>
            {t("btn.cancel")}
          </PillButton>
          <PillButton size="sm" className="danger" onClick={() => void go()} disabled={busy} aria-busy={busy || undefined}>
            {busy ? <span className="nx-spin" aria-hidden /> : null}
            {t("act.signOutGo")}
          </PillButton>
        </>
      }
    >
      {problem ? (
        <Message tone="danger" data-signout-problem="">
          {t(problem)}
        </Message>
      ) : null}
    </Dialog>
  );
}

function Waiting() {
  const { t } = useI18n();
  return (
    <p className="nx-wait mt-3" role="status">
      <span className="nx-spin" aria-hidden />
      {t("common.loading")}
    </p>
  );
}

/** A card the account could not be read for: said, with a way to ask
 * again -- never an empty list or a zero in its place. */
function Unread({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <>
      <Message tone="neutral" className="mt-3">
        {text}
      </Message>
      {onRetry ? (
        <PillButton variant="ghost" size="sm" className="mt-2 self-start" onClick={onRetry}>
          {t("act.retry")}
        </PillButton>
      ) : null}
    </>
  );
}

const DEVICE_NAMES: Record<string, TranslationKey> = {
  windows: "act.devWindows",
  macos: "act.devMac",
  linux: "act.devLinux",
  android: "act.devAndroid",
  ios: "act.devIos",
};

/** A device's name on the list: its own label (a model, or the customer's
 * words) when it has one, otherwise its kind in the app's language. */
export function deviceListName(device: Pick<AccountDevice, "label" | "platform">, t: (key: TranslationKey) => string): string {
  const label = specificDeviceLabel(device.label);
  if (label !== null) return label;
  const platform = parseDevicePlatform(device.platform);
  return t(platform ? DEVICE_NAMES[platform] : "act.devUnknown");
}

function DeviceRow({ device, now, onSignOut }: { device: AccountDevice; now: number; onSignOut?: () => void }) {
  const { t, language } = useI18n();
  const kind = deviceKind(device.platform);
  const seen = device.lastSeenAt ? formatAgo(new Date(device.lastSeenAt).getTime(), language, now) : null;
  const signedIn = formatDate(device.signedInAt, language);
  return (
    <li className="nx-arow" data-device={device.thisDevice ? "this" : undefined}>
      <span className="nx-flagbox auto" aria-hidden>
        {kind === "phone" ? <Smartphone /> : kind === "computer" ? <Monitor /> : <MonitorSmartphone />}
      </span>
      <span className="t">
        <span className="n">
          <bdi>{deviceListName(device, t)}</bdi>
          {device.thisDevice ? (
            <>
              {" "}
              <span className="nx-ntag">{t("act.thisDevice")}</span>
            </>
          ) : null}
        </span>
        <span className="s">{seen ? t("act.signedInSeen", { signedIn, seen }) : t("act.signedIn", { signedIn })}</span>
      </span>
      {/* Only ever a yes: no mark says nothing either way. */}
      {device.inUse ? (
        <span className="nx-res ok">
          <Check aria-hidden />
          {t("act.inUse")}
        </span>
      ) : null}
      {onSignOut ? (
        <button
          type="button"
          className="nx-ibtn sm"
          onClick={onSignOut}
          aria-label={t("act.signOutDevice", { device: deviceListName(device, t) })}
          title={t("act.signOutDevice", { device: deviceListName(device, t) })}
          data-device-signout=""
        >
          <LogOut aria-hidden />
        </button>
      ) : null}
    </li>
  );
}

function UsageBody({ usage, now }: { usage: DailyUsage; now: number }) {
  const { t, language } = useI18n();
  const chart = usageChart(usage);
  const total = sizeParts(chart.total, language);
  const first = chart.bars[0];
  const last = chart.bars[chart.bars.length - 1];
  const utc = usage.timeZone === "UTC" && deviceTimeZone() !== "UTC";
  return (
    <>
      <p className="nx-bigstat">
        {total.value}
        <small>
          {total.unit} · {t("act.usagePeriod", { n: formatNumber(chart.bars.length, language) })}
        </small>
      </p>
      <ol className="nx-ubars m-0 list-none p-0" aria-label={t("act.usage")}>
        {chart.bars.map((bar) => {
          const words = t("act.usageDay", {
            date: formatDay(bar.date, language),
            down: formatSize(bar.down, language),
            up: formatSize(bar.up, language),
          });
          return (
            <li key={bar.date} title={words}>
              <span className="bar" data-zero={bar.total === 0 ? "1" : undefined} style={{ blockSize: `${(bar.total / chart.max) * 100}%` }} aria-hidden />
              <span className="nx-sr">{words}</span>
            </li>
          );
        })}
      </ol>
      {first && last ? (
        <p className="nx-uaxis" aria-hidden>
          <span>{formatDay(first.date, language)}</span>
          <span>{formatDay(last.date, language)}</span>
        </p>
      ) : null}
      {chart.today ? (
        <dl className="nx-kv">
          <dt>{t("act.today")}</dt>
          <dd>{formatSize(chart.today.total, language)}</dd>
        </dl>
      ) : null}
      <p className="nx-tiny">
        {t("act.usageAsOf", { when: formatAgo(new Date(usage.asOf).getTime(), language, now) })}
        {utc ? ` ${t("act.usageUtc")}` : ""}
      </p>
    </>
  );
}

/** The session log: its switch, what it holds, newest first, and Clear. */
function SessionLogGroup({ log, routes }: { log: SessionLogView; routes: readonly RouteOption[] }) {
  const { t, language } = useI18n();
  const [askClear, setAskClear] = useState(false);
  const records = [...log.records].reverse();
  return (
    <div className="nx-group" data-activity-log>
      <h2 className="nx-gt">{t("act.history")}</h2>
      <div className="nx-rows">
        <SwitchRow
          icon={<History />}
          label={t("set.history")}
          hint={t("set.historyHint")}
          checked={log.enabled}
          disabled={!log.loaded}
          onChange={log.onEnabled}
        />
        {log.enabled && log.loaded && records.length === 0 ? <Row label={t("act.logEmpty")} /> : null}
        {log.enabled
          ? records.map((record) => <LogRow key={record.id} record={record} routes={routes} language={language} />)
          : null}
        {log.enabled && records.length > 0 ? (
          <Row icon={<Trash2 />} label={t("act.logClear")} danger onClick={() => setAskClear(true)} />
        ) : null}
      </div>
      <Dialog
        open={askClear}
        title={t("act.logClearTitle")}
        description={t("act.logClearBody")}
        onClose={() => setAskClear(false)}
        actions={
          <>
            <PillButton variant="ghost" size="sm" onClick={() => setAskClear(false)}>
              {t("btn.cancel")}
            </PillButton>
            <PillButton
              size="sm"
              className="danger"
              onClick={() => {
                setAskClear(false);
                log.onClear();
              }}
            >
              {t("act.logClearGo")}
            </PillButton>
          </>
        }
      />
    </div>
  );
}

function LogRow({ record, routes, language }: { record: SessionRecord; routes: readonly RouteOption[]; language: Language }) {
  const { t } = useI18n();
  const route = record.routeId ? routes.find((r) => r.id === record.routeId) : undefined;
  const protocol = record.protocol ? customerProtocolLabel(record.protocol as RouteOption["protocol"], record.transport) : null;
  const place = route ? placeLabel(route, language) : t("act.unlisted");
  const label = protocol ? `${place} · ${protocol}` : place;
  const range = t("act.logRange", {
    day: formatDate(record.start, language),
    from: formatTime(record.start, language),
    to: record.open ? t("act.logNow") : record.end !== null ? formatTime(record.end, language) : t("act.logNoEnd"),
  });
  const parts = [range];
  if (!record.open && record.end !== null) parts.push(formatDuration((record.end - record.start) / 1000, language));
  if (record.rxBytes !== null && record.txBytes !== null) {
    parts.push(t("act.logBytes", { down: formatSize(record.rxBytes, language), up: formatSize(record.txBytes, language) }));
  }
  return <Row label={<bdi>{label}</bdi>} hint={parts.join(" · ")} value={record.ended === "lost" ? t("act.logLost") : undefined} />;
}
