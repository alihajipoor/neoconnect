import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  AppWindow,
  BarChart3,
  Bell,
  CreditCard,
  Eye,
  Gamepad2,
  Gift,
  KeyRound,
  Languages,
  LifeBuoy,
  LogOut,
  Mail,
  Palette,
  Play,
  Power,
  ShieldCheck,
  Sparkles,
  Trash2,
  Info,
  WifiOff,
  Wrench,
  Check,
} from "lucide-react";
import { changePassword, deleteAccount } from "../lib/auth";
import { getMe } from "../lib/customer";
import type { Customer } from "../lib/types";
import {
  BackupRouteSection,
  RecoveryCodeSection,
  SetPasswordSection,
  VerifyEmailReminder,
} from "../components/AccountRecovery";
import { LANGUAGES, useI18n, type Language } from "../lib/i18n";
import { failureText } from "../lib/failure-text";
import { IS_STORE_BUILD } from "../lib/distribution";
import { effects, type GlassChoice, type GlassTier, type ThemeChoice } from "../lib/effects";
import {
  Card,
  CardHead,
  ListGroup,
  Message,
  PasswordField,
  PillButton,
  Row,
  Segmented,
  SwitchRow,
  TextField,
} from "../components/ui";
import { Dialog } from "../components/overlay";
import { Page } from "../components/shell/Page";
import { RepairNetwork } from "../components/RepairNetwork";
import { CommunityLinks } from "../components/CommunityLinks";
import { StillTrying } from "../components/StillTrying";
import { relaySupported } from "../lib/last-resort";
import { appPrefs, type AppPrefs } from "../lib/app-prefs";
import type { AutostartBinding } from "../lib/autostart";
import type { NotifySetting } from "../lib/notify";

/** Which device this is: decides the rows that only exist on one of them
 * (gaming mode, Custom mode, Repair and leak protection are Windows's; the
 * web portal has none of them). */
export type SettingsPlatform = "windows" | "android" | "ios" | "web";

/** What this platform does for the device's own behaviour. A row exists
 * only for what the platform has bound -- a switch nothing honours is not
 * drawn, on any platform (no "Not built yet" ships):
 *
 *  - `autostart`: Windows' Run key, read back each time (lib/autostart.ts);
 *  - `autoConnect`: the main page connects at launch when it is on
 *    (lib/auto-connect.ts);
 *  - `notifications`: the main page notifies on a lasting change
 *    (lib/connection-notify.ts) -- on a phone, the tunnel's own service or
 *    extension does (apps/mobile lib/phone-notices.ts) -- and how to ask
 *    whether the OS shows them, to ask it to, and to open its settings;
 *  - `reconnectHold`: the service holds the internet while reconnecting
 *    (lib/reconnect-hold.ts), told at once when the switch moves. */
export interface DeviceSettings {
  autostart?: AutostartBinding;
  autoConnect?: boolean;
  notifications?: {
    setting?: () => Promise<NotifySetting>;
    /** Raises the system's own question, where it can still be asked. */
    request?: () => Promise<NotifySetting>;
    /** The system's settings for this app's notifications. */
    openSettings?: () => Promise<void>;
  };
  reconnectHold?: { apply: (enabled: boolean) => Promise<void> };
}

/** The app's settings, as grouped lists (design-system.md 4.10), ordered
 * from everyday to rare: Connection, Modes, Appearance, Notifications,
 * Account, Troubleshoot, About.
 *
 * A setting the platform does not honour is not shown at all
 * (`DeviceSettings`) -- never as a control that looks like it works. A
 * value the operating system decides (reduced transparency, reduced
 * motion) is shown as set by it, and its control is disabled.
 *
 * Gaming mode, Custom mode, the password, the recovery code and Repair open
 * their existing cards in a sub-view of this page, unchanged; deleting the
 * account and signing out ask first, in a dialog. */
type SubView = "gaming" | "custom" | "password" | "recovery" | "repair";

const OS_NAME: Record<SettingsPlatform, "set.osWin" | "set.osAndroid" | "set.osIos" | null> = {
  windows: "set.osWin",
  android: "set.osAndroid",
  ios: "set.osIos",
  web: null,
};

export function Settings({
  onBack,
  onOpenReferrals,
  onOpenSupport,
  onLoggedOut,
  customSection,
  gamingSection,
  onOpenPlans,
  onOpenActivity,
  onSignOut,
  platform = "web",
  device = NO_DEVICE,
  aboutExtra,
}: {
  onBack: () => void;
  onOpenReferrals: () => void;
  onOpenSupport: () => void;
  /** Where to send someone whose account no longer exists.
   *
   * The same callback the app already uses for signing out, because the
   * end state is identical -- no session, back at the login screen. The
   * difference is only that there is nothing to sign back into. */
  onLoggedOut: () => void;
  /** Custom mode's pane, supplied by the platform rather than imported.
   *
   * Language and password are the same product on every platform and
   * live here. Custom mode is not: Windows drives WinDivert and a
   * transparent proxy and picks .exe paths from a file dialog, while
   * Android hands package names to VpnService.Builder and picks them
   * from the installed-app list. Same feature, nothing shared but the
   * slot it sits in. */
  customSection: ReactNode;
  /** Gaming mode's pane, and optional on purpose.
   *
   * This screen is compiled by the mobile app as well as by Windows, and
   * gaming mode is a Windows feature today: it installs namespace-scoped
   * DNS rules through the helper service, which has no counterpart on
   * Android or iOS. Optional rather than required means the row simply
   * does not appear where there is nothing behind it -- which is better
   * than a section that opens onto an apology.
   *
   * That is a platform gap and worth stating plainly rather than
   * quietly: the mode is not offered on mobile yet. */
  gamingSection?: ReactNode;
  /** Plans (the store's on an iPhone build: guideline 3.1.1). */
  onOpenPlans?: () => void;
  onOpenActivity?: () => void;
  /** Signing out, after the dialog here has asked. The app's own sign-out:
   * it stops an automatic reconnect and takes the tunnel down first. */
  onSignOut?: () => void;
  platform?: SettingsPlatform;
  /** What this platform has bound; nothing, on the web portal. */
  device?: DeviceSettings;
  /** A row of the platform's own under the version: the direct Android
   * build's "newer version available". */
  aboutExtra?: ReactNode;
}) {
  const { t, language, setLanguage } = useI18n();
  const [sub, setSub] = useState<SubView | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [askSignOut, setAskSignOut] = useState(false);
  const [askDelete, setAskDelete] = useState(false);
  const [askLeak, setAskLeak] = useState(false);
  const stayRef = useRef<HTMLButtonElement>(null);
  const fx = useSyncExternalStore(effects.subscribe, effects.current, effects.current);
  const prefs = useAppPrefs();

  // The account decides which of the ways back in apply
  // (docs/relay-last-resort.md): a reminder to confirm the address for an
  // account that came in by the relay and has not (R3.6); a password to
  // set, rather than one to change, for a Google, Apple or Facebook
  // account that has none (R4.4); and the recovery code, from a backend
  // new enough to say whether there is one (R4.3). Until the account has
  // been read -- or if it cannot be -- the rows are what they always were.
  const load = useCallback(() => {
    void getMe().then((result) => {
      if (result.ok) setCustomer(result.data);
    });
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    let alive = true;
    void getVersion().then(
      (v) => alive && setVersion(v),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, []);

  const windows = platform === "windows";
  const osName = OS_NAME[platform] ? t(OS_NAME[platform]!) : null;
  const unconfirmedRelay = customer !== null && !customer.emailVerifiedAt && Boolean(customer.relayUnverifiedSince);
  const socialOnly = customer?.hasPassword === false;

  if (sub !== null) {
    const titles: Record<SubView, string> = {
      gaming: t("set.gaming"),
      custom: platform === "android" ? t("set.perApp") : t("set.custom"),
      password: socialOnly ? t("setpw.title") : t("settings.changePassword"),
      recovery: t("recovery.settingsTitle"),
      repair: t("repair.title"),
    };
    return (
      <Page title={titles[sub]} back={() => setSub(null)} backAlways backLabel={t("settings.title")} data-settings-sub={sub}>
        <div className="nx-sub">
          <div className="nx-stack">
            {sub === "gaming" ? gamingSection : null}
            {sub === "custom" ? customSection : null}
            {sub === "password" ? socialOnly ? <SetPasswordSection onDone={load} /> : <PasswordSection /> : null}
            {sub === "recovery" && customer !== null && customer.hasRecoveryCode !== undefined ? (
              <RecoveryCodeSection
                hasPassword={customer.hasPassword !== false}
                hasRecoveryCode={customer.hasRecoveryCode}
                onCreated={load}
              />
            ) : null}
            {sub === "repair" ? <RepairNetwork /> : null}
          </div>
        </div>
      </Page>
    );
  }

  const themeOptions: { value: ThemeChoice; label: string }[] = [
    { value: "system", label: t("set.system") },
    { value: "light", label: t("set.light") },
    { value: "dark", label: t("set.dark") },
  ];
  const glassOptions: { value: GlassTier; label: string }[] = [
    { value: "full", label: t("set.full") },
    { value: "lite", label: t("set.lite") },
    { value: "flat", label: t("set.off") },
  ];
  // "auto" shows as the tier it chose on this device.
  const glassShown: GlassTier = fx.glassOsSet ? "flat" : fx.glassChoice === "auto" ? fx.glass : fx.glassChoice;

  return (
    <Page title={t("settings.title")} lede={t("set.lede")} back={onBack} data-settings>
      {unconfirmedRelay ? <VerifyEmailReminder email={customer.email} onChanged={load} /> : null}

      <div className="nx-cols">
        {/* Only with a row in it: the web portal has no tunnel and no relay,
            and an empty titled card says there is something to set. */}
        {windows || device.autostart || device.autoConnect || device.reconnectHold || relaySupported() ? (
          <ListGroup title={t("set.connection")}>
            {windows ? (
              <Row
                icon={<ShieldCheck />}
                label={t("set.leak")}
                value={t("set.leakVal")}
                onClick={() => setAskLeak(true)}
              />
            ) : null}
            {/* The relay of last resort's switch: on until turned off here
                (last-resort.ts). Nothing where there is no relay. */}
            <BackupRouteSection />
            {device.autostart ? <AutostartRow binding={device.autostart} /> : null}
            {device.autoConnect ? (
              <SwitchRow
                icon={<Play />}
                label={t("set.autoConnect")}
                hint={t("set.autoConnectHint")}
                checked={prefs.value.autoConnect}
                disabled={!prefs.loaded}
                onChange={(next) => void appPrefs.set("autoConnect", next)}
              />
            ) : null}
            {device.reconnectHold ? (
              <SwitchRow
                icon={<WifiOff />}
                label={t("set.blockRecon")}
                tag={<span className="nx-ntag">{t("set.beta")}</span>}
                hint={t("set.killHint")}
                checked={prefs.value.blockWhileReconnecting}
                disabled={!prefs.loaded}
                onChange={(next) => {
                  void appPrefs.set("blockWhileReconnecting", next);
                  // The live session is told at once: armed now, or let go
                  // of. A service that cannot be reached is told on the
                  // next connect, which always says.
                  void device.reconnectHold?.apply(next).catch(() => undefined);
                }}
              />
            ) : null}
          </ListGroup>
        ) : null}

        {gamingSection || customSection || platform === "ios" ? (
          <ListGroup title={t("set.modes")}>
            {gamingSection ? (
              <Row
                icon={<Gamepad2 />}
                label={t("set.gaming")}
                tag={<span className="nx-ntag">{t("set.beta")}</span>}
                hint={t("set.gamingHint")}
                onClick={() => setSub("gaming")}
              />
            ) : null}
            {customSection ? (
              <Row
                icon={<AppWindow />}
                label={platform === "android" ? t("set.perApp") : t("set.custom")}
                tag={windows ? <span className="nx-ntag">{t("set.beta")}</span> : undefined}
                hint={t("set.customHint")}
                onClick={() => setSub("custom")}
              />
            ) : platform === "ios" ? (
              // Said plainly, not hidden: the system decides this on iPhone.
              <Row icon={<Info />} label={t("set.perApp")} hint={t("set.perAppIos")} />
            ) : null}
          </ListGroup>
        ) : null}

        <ListGroup title={t("set.appearance")}>
          <Row
            icon={<Languages />}
            label={t("settings.language")}
            hint={t("set.languageHint")}
            wrap
            control={
              <Segmented
                size="sm"
                label={t("settings.language")}
                value={language}
                onChange={(next: Language) => setLanguage(next)}
                options={(Object.keys(LANGUAGES) as Language[]).map((code) => ({ value: code, label: LANGUAGES[code].nativeLabel }))}
              />
            }
          />
          <Row
            icon={<Palette />}
            label={t("set.appearance")}
            wrap
            control={
              <Segmented size="sm" label={t("set.appearance")} value={fx.theme} onChange={(next) => effects.setTheme(next)} options={themeOptions} />
            }
          />
          <Row
            icon={<Sparkles />}
            label={t("set.effects")}
            hint={
              fx.glassOsSet && osName ? (
                <span className="nx-osset">{t("set.osSet", { v: t("set.off"), os: osName })}</span>
              ) : (
                t("set.effectsHint")
              )
            }
            wrap
            control={
              <Segmented
                size="sm"
                label={t("set.effects")}
                value={glassShown}
                locked={fx.glassOsSet}
                lockedReason={osName ? t("set.osSet", { v: t("set.off"), os: osName }) : undefined}
                onChange={(next: GlassChoice) => effects.setGlass(next)}
                options={glassOptions}
              />
            }
          />
          <SwitchRow
            icon={<Eye />}
            label={t("set.motion")}
            hint={
              fx.motionOsSet && osName ? (
                <span className="nx-osset">{t("set.osSet", { v: t("set.on"), os: osName })}</span>
              ) : (
                t("set.motionHint")
              )
            }
            checked={fx.reduceMotion}
            disabled={fx.motionOsSet}
            onChange={(next) => effects.setMotion(next ? true : null)}
          />
        </ListGroup>

        {device.notifications ? (
          <ListGroup title={t("set.notifs")}>
            <NotificationsRow
              checked={prefs.value.notifications}
              disabled={!prefs.loaded}
              binding={device.notifications}
              platform={platform}
              osName={osName}
            />
          </ListGroup>
        ) : null}

        <ListGroup title={t("settings.account")}>
          {customer ? (
            <Row
              icon={<Mail />}
              label={t("auth.email")}
              hint={
                <bdi dir="ltr" className="nx-strong">
                  {customer.email}
                </bdi>
              }
            />
          ) : null}
          <Row
            icon={<KeyRound />}
            label={socialOnly ? t("setpw.title") : t("set.password")}
            value={socialOnly ? undefined : t("set.change")}
            onClick={() => setSub("password")}
          />
          {customer !== null && customer.hasRecoveryCode !== undefined ? (
            <Row
              icon={<KeyRound />}
              label={t("set.recovery")}
              hint={customer.hasRecoveryCode ? t("recovery.has") : t("recovery.none")}
              value={customer.hasRecoveryCode ? undefined : t("set.create")}
              onClick={() => setSub("recovery")}
            />
          ) : null}
          {onOpenPlans ? (
            <Row icon={<CreditCard />} label={t(IS_STORE_BUILD ? "nav.plansStore" : "nav.plans")} onClick={onOpenPlans} />
          ) : null}
          {onOpenActivity ? <Row icon={<BarChart3 />} label={t("nav.activity")} onClick={onOpenActivity} /> : null}
          <Row icon={<Gift />} label={t("referrals.title")} onClick={onOpenReferrals} />
          {onSignOut ? (
            <Row icon={<LogOut />} label={t("nav.signOut")} value={t("set.signOutHint")} onClick={() => setAskSignOut(true)} />
          ) : null}
          <Row
            icon={<Trash2 />}
            label={t("settings.deleteAccount")}
            hint={t("settings.deleteAccountHint")}
            danger
            onClick={() => setAskDelete(true)}
          />
        </ListGroup>

        <ListGroup title={t("set.troubleshoot")}>
          {windows ? <Row icon={<Wrench />} label={t("set.repair")} hint={t("set.repairHint")} onClick={() => setSub("repair")} /> : null}
          <Row icon={<LifeBuoy />} label={t("support.title")} hint={t("set.supportHint")} onClick={onOpenSupport} />
        </ListGroup>

        <ListGroup title={t("set.about")}>
          {/* Once it is known: a build that cannot say its version shows no
              row, not a dash. */}
          {version ? <Row label={t("set.version")} value={<bdi dir="ltr">{version}</bdi>} /> : null}
          {aboutExtra}
          <CommunityRow />
        </ListGroup>
      </div>

      <DeleteAccountDialog open={askDelete} onClose={() => setAskDelete(false)} onDeleted={onLoggedOut} />

      <Dialog
        open={askSignOut}
        title={t("so.title")}
        description={t("so.body")}
        onClose={() => setAskSignOut(false)}
        initialFocus={stayRef}
        actions={
          <>
            <PillButton ref={stayRef} variant="ghost" size="sm" onClick={() => setAskSignOut(false)}>
              {t("btn.cancel")}
            </PillButton>
            <PillButton
              size="sm"
              onClick={() => {
                setAskSignOut(false);
                onSignOut?.();
              }}
            >
              {t("so.go")}
            </PillButton>
          </>
        }
      />

      {/* Read-only: a description of what the tunnel holds, not a switch. */}
      <Dialog
        open={askLeak}
        title={t("set.leak")}
        description={t("leak.lede")}
        onClose={() => setAskLeak(false)}
        actions={
          <PillButton size="sm" onClick={() => setAskLeak(false)}>
            {t("dlg.close")}
          </PillButton>
        }
      >
        <ul className="nx-leak">
          <li className="ok">
            <Check aria-hidden />
            <span>
              <b>{t("leak.heldLead")}</b> {t("leak.held")}
            </span>
          </li>
          <li>
            <Info aria-hidden />
            <span>
              <b>{t("leak.notHeldLead")}</b> {t("leak.notHeld")}
            </span>
          </li>
          <li className={windows && prefs.value.blockWhileReconnecting ? "ok" : undefined}>
            {windows && prefs.value.blockWhileReconnecting ? <Check aria-hidden /> : <Info aria-hidden />}
            <span>
              <b>{t("leak.reconLead")}</b>{" "}
              {t(windows && prefs.value.blockWhileReconnecting ? "leak.reconHeld" : "leak.recon")}
            </span>
          </li>
        </ul>
      </Dialog>
    </Page>
  );
}

const NO_DEVICE: DeviceSettings = {};

/** The device's preferences, and whether they have been read in this run:
 * a switch is not offered before then, so it never shows a default as the
 * saved answer. */
function useAppPrefs(): { value: AppPrefs; loaded: boolean } {
  const value = useSyncExternalStore(appPrefs.subscribe, appPrefs.current, appPrefs.current);
  const [loaded, setLoaded] = useState(appPrefs.loaded());
  useEffect(() => {
    let alive = true;
    void appPrefs.load().then(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);
  return { value, loaded };
}

/** "Open Neoxify when I sign in to Windows": read from Windows when the
 * page opens, and after a change shows what Windows then says -- not what
 * was pressed (lib/autostart.ts). Until the first answer the switch is
 * not offered. */
function AutostartRow({ binding }: { binding: AutostartBinding }) {
  const { t } = useI18n();
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    binding.read().then(
      (value) => alive && setOn(value),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [binding]);
  async function change(next: boolean) {
    setBusy(true);
    setFailed(false);
    try {
      setOn(await binding.write(next));
    } catch {
      setFailed(true);
      // What Windows holds now, whatever the write did.
      await binding.read().then(setOn, () => undefined);
    } finally {
      setBusy(false);
    }
  }
  return (
    <SwitchRow
      icon={<Power />}
      label={t("set.autoStart")}
      hint={failed ? <span className="nx-osset">{t("set.autoStartFailed")}</span> : t("set.autoStartHint")}
      checked={on === true}
      disabled={on === null || busy}
      onChange={(next) => void change(next)}
    />
  );
}

/** "Notify me when the connection changes", and, under it, whether the
 * operating system shows them at all: switched on here and off in the
 * system shows nothing, and the row says so rather than looking like it
 * works.
 *
 * On a phone the system has to be asked first (Android 13+, iOS). The
 * question is the system's own, raised only by the customer: turning the
 * switch on, or the "Allow notifications" row under it while it is on and
 * nobody has asked. Once the system has said no, only its settings can
 * change it, and the row under the switch opens them. The answer is read
 * again whenever the app comes back to the front -- from those settings,
 * usually. */
function NotificationsRow({
  checked,
  disabled,
  binding,
  platform,
  osName,
}: {
  checked: boolean;
  disabled: boolean;
  binding: NonNullable<DeviceSettings["notifications"]>;
  platform: SettingsPlatform;
  osName: string | null;
}) {
  const { t } = useI18n();
  const [os, setOs] = useState<NotifySetting>("unknown");
  const [asking, setAsking] = useState(false);
  const read = binding.setting;
  useEffect(() => {
    if (!read) return;
    let alive = true;
    const look = () => void read().then((value) => alive && setOs(value), () => undefined);
    look();
    const onVisible = () => {
      if (document.visibilityState === "visible") look();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [read]);
  async function ask() {
    if (!binding.request || asking) return;
    setAsking(true);
    try {
      setOs(await binding.request());
    } catch {
      // Nothing was decided; the row still offers the question.
    } finally {
      setAsking(false);
    }
  }
  const view = notificationsRowView({
    checked,
    os,
    platform,
    canRequest: Boolean(binding.request),
    canOpen: Boolean(binding.openSettings),
  });
  const hint =
    view.hint === "set.notifsCanAsk" || view.hint === "set.notifsOffPhone" ? (
      <span className="nx-osset">{t(view.hint, { os: osName ?? "" })}</span>
    ) : view.blocked ? (
      <span className="nx-osset">{t(view.hint)}</span>
    ) : (
      t(view.hint)
    );
  return (
    <>
      <SwitchRow
        icon={<Bell />}
        label={t("set.notifications")}
        hint={hint}
        checked={checked}
        disabled={disabled}
        onChange={(next) => {
          void appPrefs.set("notifications", next);
          // Turned on where the system has not been asked: the switch is
          // the customer's answer, so the system's question follows it.
          if (next && os === "canAsk") void ask();
        }}
      />
      {view.action === "ask" ? <Row label={t("set.notifsAllow")} onClick={() => void ask()} disabled={asking} /> : null}
      {view.action === "open" && osName ? (
        <Row
          label={t("set.notifsOpen", { os: osName })}
          onClick={() => void binding.openSettings?.().catch(() => undefined)}
        />
      ) : null}
    </>
  );
}

type NotifyHint =
  | "set.notificationsHint"
  | "set.notificationsHintAndroid"
  | "set.notificationsHintIos"
  | "set.notifsCanAsk"
  | "set.notifsOffPhone"
  | "set.notifsOffApp"
  | "set.notifsOffAll"
  | "set.notifsOffPolicy";

/** What the notifications row says under its switch, and the row it adds
 * under it: the system's question while it can still be asked, or the
 * system's settings once it has said no. Only while the switch is on: off,
 * whether the system would show them does not matter. */
export function notificationsRowView(input: {
  checked: boolean;
  os: NotifySetting;
  platform: SettingsPlatform;
  canRequest: boolean;
  canOpen: boolean;
}): { hint: NotifyHint; blocked: boolean; action: "ask" | "open" | null } {
  const phone = input.platform === "android" || input.platform === "ios";
  if (input.checked && phone && input.os === "canAsk" && input.canRequest) {
    return { hint: "set.notifsCanAsk", blocked: true, action: "ask" };
  }
  if (input.checked && phone && input.os === "disabledForApp") {
    return { hint: "set.notifsOffPhone", blocked: true, action: input.canOpen ? "open" : null };
  }
  const windowsBlock = phone ? null : OS_BLOCKS[input.os];
  if (input.checked && windowsBlock) return { hint: windowsBlock, blocked: true, action: null };
  return { hint: HINT[input.platform], blocked: false, action: null };
}

/** What the switch does, by platform: Windows notifies from the main page,
 * a phone from the tunnel's own service or extension, which say less. */
const HINT: Record<SettingsPlatform, "set.notificationsHint" | "set.notificationsHintAndroid" | "set.notificationsHintIos"> = {
  windows: "set.notificationsHint",
  android: "set.notificationsHintAndroid",
  ios: "set.notificationsHintIos",
  web: "set.notificationsHint",
};

/** What Windows' own setting means for the switch above, when it stops
 * the notifications showing. "unknown" says nothing: a build with no
 * shortcut to show them under, or a question that could not be asked. */
const OS_BLOCKS: Record<NotifySetting, "set.notifsOffApp" | "set.notifsOffAll" | "set.notifsOffPolicy" | null> = {
  enabled: null,
  canAsk: null,
  disabledForApp: "set.notifsOffApp",
  disabledForUser: "set.notifsOffAll",
  disabledByPolicy: "set.notifsOffPolicy",
  unknown: null,
};

/** Website, Discord, Instagram, Telegram -- whichever exist (CommunityLinks
 * decides, and drops the website from a store build). */
function CommunityRow() {
  const { t } = useI18n();
  const [shown, setShown] = useState(true);
  if (!shown) return null;
  return <Row label={t("set.community")} wrap control={<CommunityLinks look="chips" onNone={() => setShown(false)} />} />;
}

function PasswordSection() {
  const { t } = useI18n();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const tooShort = next.length > 0 && next.length < 8;
  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = current.length > 0 && next.length >= 8 && next === confirm && !busy;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setDone(false);
    setBusy(true);

    const result = await changePassword(current, next);
    setBusy(false);

    if (!result.ok) {
      setError(failureText(result, t));
      return;
    }
    // Cleared rather than left filled: this screen stays open afterwards,
    // and leaving a password sitting in an input is the kind of thing
    // someone walks away from.
    setCurrent("");
    setNext("");
    setConfirm("");
    setDone(true);
  }

  return (
    <Card className="flex flex-col gap-4">
      <CardHead icon={<KeyRound />} title={t("settings.changePassword")} hint={t("settings.changePasswordHint")} />
      <form onSubmit={submit} className="nx-form">
        <PasswordField
          id="current"
          label={t("settings.currentPassword")}
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <PasswordField
          id="next"
          label={t("settings.newPassword")}
          hint={tooShort ? t("settings.tooShort") : undefined}
          hintTone="danger"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <PasswordField
          id="confirm"
          label={t("settings.confirmPassword")}
          hint={mismatch ? t("settings.mismatch") : undefined}
          hintTone="danger"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {error ? <Message tone="danger">{error}</Message> : null}
        {done ? <Message tone="ok">{t("settings.passwordChanged")}</Message> : null}
        <PillButton type="submit" size="sm" disabled={!canSubmit} aria-busy={busy || undefined}>
          {busy ? t("settings.changing") : t("settings.changePassword")}
        </PillButton>
        {/* A write asks who answers first, so this can take half a minute
            where only a slow route answers. */}
        <StillTrying waiting={busy} />
      </form>
    </Card>
  );
}

/** Deleting your own account.
 *
 * Present because both stores require it of any app offering account
 * creation -- Apple 5.1.1(v), Play's data deletion policy -- and absent
 * from neither build, since it is not a transaction and no store
 * objects to it.
 *
 * A dialog that asks for the word rather than another button. A second
 * button is a reflex; typing something is a decision. This is the one
 * action in the app that cannot be undone, and the dialog names what
 * actually goes rather than asking "are you sure" about an unspecified
 * thing. Its first focus is the field, never the destructive button.
 */
function DeleteAccountDialog({ open, onClose, onDeleted }: { open: boolean; onClose: () => void; onDeleted: () => void }) {
  const { t } = useI18n();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);

  // Matched case-insensitively and trimmed: the point is deliberateness,
  // not typing accuracy, and failing someone on a capital letter after
  // they decided to leave is just rude.
  const phrase = t("settings.deleteConfirmWord");
  const matches = typed.trim().toLowerCase() === phrase.toLowerCase();

  function close() {
    if (busy) return;
    setTyped("");
    setError(null);
    onClose();
  }

  async function submit() {
    if (!matches || busy) return;
    setError(null);
    setBusy(true);

    const result = await deleteAccount();
    setBusy(false);

    if (!result.ok) {
      setError(failureText(result, t));
      return;
    }
    // No success state on this screen -- there is no account left for it
    // to belong to. Straight back to the login screen.
    onDeleted();
  }

  return (
    <Dialog
      open={open}
      alert
      title={t("settings.deleteAccount")}
      // Named, not vague. Someone deleting an account with paid time left
      // should learn that here and not afterwards.
      description={t("settings.deleteWarning")}
      onClose={close}
      initialFocus={field}
      actions={
        <>
          <PillButton variant="ghost" size="sm" onClick={close} disabled={busy}>
            {t("settings.deleteCancel")}
          </PillButton>
          <PillButton size="sm" className="danger" disabled={!matches || busy} aria-busy={busy || undefined} onClick={() => void submit()}>
            {busy ? t("settings.deleting") : t("settings.deleteConfirm")}
          </PillButton>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <TextField
          ref={field}
          id="delete-confirm"
          label={t("settings.deleteTypeToConfirm", { word: phrase })}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          dir="ltr"
        />
        {error ? <Message tone="danger">{error}</Message> : null}
        <StillTrying waiting={busy} />
      </form>
    </Dialog>
  );
}
