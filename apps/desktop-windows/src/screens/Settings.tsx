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

/** Which device this is: decides the rows that only exist on one of them
 * (gaming mode, Custom mode, Repair and leak protection are Windows's; the
 * web portal has none of them). */
export type SettingsPlatform = "windows" | "android" | "ios" | "web";

/** The app's settings, as grouped lists (design-system.md 4.10), ordered
 * from everyday to rare: Connection, Modes, Appearance, Notifications,
 * Account, Troubleshoot, About.
 *
 * A setting the app cannot honour yet is shown disabled and tagged "Not
 * built yet" -- never as a control that looks like it works. A value the
 * operating system decides (reduced transparency, reduced motion) is shown
 * as set by it, and its control is disabled.
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
        {platform !== "web" || relaySupported() ? (
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
            {windows ? <SwitchRow icon={<Power />} label={t("set.autoStart")} checked={false} notBuilt /> : null}
            {platform !== "web" ? <SwitchRow icon={<Play />} label={t("set.autoConnect")} checked={false} notBuilt /> : null}
            {windows ? (
              <SwitchRow icon={<WifiOff />} label={t("set.blockRecon")} hint={t("set.killHint")} checked={false} notBuilt />
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

        {platform !== "web" ? (
          <ListGroup title={t("set.notifs")}>
            <SwitchRow icon={<Bell />} label={t("set.notifications")} checked={false} notBuilt />
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
          <li>
            <Info aria-hidden />
            <span>
              <b>{t("leak.reconLead")}</b> {t("leak.recon")}
            </span>
          </li>
        </ul>
      </Dialog>
    </Page>
  );
}

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
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <PasswordField
          id="confirm"
          label={t("settings.confirmPassword")}
          hint={mismatch ? t("settings.mismatch") : undefined}
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
