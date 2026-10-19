import { useState } from "react";
import { Check, KeyRound, Loader2, Mail, Route } from "lucide-react";
import {
  changeUnverifiedEmail,
  createRecoveryCode,
  resendVerification,
  setPassword,
  verifyEmailByCode,
} from "../lib/auth";
import { failureText } from "../lib/failure-text";
import { useI18n } from "../lib/i18n";
import { backupRouteOn, relaySupported, setBackupRouteOn } from "../lib/last-resort";
import { Button, Card, Input, Label } from "./ui";
import { StillTrying } from "./StillTrying";
import { RecoveryCodeNotice, relayDetail, useRelayMode } from "./BackupRoute";

/** The account's ways back in, for the time mail and the social providers
 * cannot be reached (docs/relay-last-resort.md, R3.6, R4.3, R4.4, F9):
 * confirming an address later, correcting one never confirmed, a recovery
 * code, a password for a social-only account -- and the switch for the
 * backup route itself. Shared by both clients' Settings. */

function Header({ icon: Icon, title, hint }: { icon: typeof Mail; title: string; hint: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
        <Icon className="size-4" />
      </div>
      <div>
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

function Problem({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{text}</p>
  );
}

function Done({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="flex items-center gap-1.5 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
      <Check className="size-3.5" />
      {text}
    </p>
  );
}

/** "Confirm your email to unlock all plans and payments." For an account
 * that came in by the relay and has not confirmed its address (R3.6):
 * neutral, never a warning colour -- the plan it has keeps working, and
 * nothing is due. Confirming here, by the emailed code, lifts every limit;
 * so does a reset by emailed code. The address can be corrected first,
 * three times a day, because a typo here is a paid account nobody could
 * ever confirm (F9). */
export function VerifyEmailReminder({
  email,
  onChanged,
}: {
  email: string;
  /** Verified, or the address changed: the caller reads the account again. */
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [changing, setChanging] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newEmailAgain, setNewEmailAgain] = useState("");
  const [password, setPasswordText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function send() {
    setError(null);
    setBusy(true);
    const result = await resendVerification(email);
    setBusy(false);
    if (!result.ok) setError(failureText(result, t));
    setSent(true);
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const result = await verifyEmailByCode(email, code.trim());
    setBusy(false);
    if (!result.ok) return setError(failureText(result, t));
    setDone(t("verify.confirmed"));
    onChanged();
  }

  async function change(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (newEmail.trim().toLowerCase() !== newEmailAgain.trim().toLowerCase()) return setError(t("relay.emailMismatch"));
    setBusy(true);
    const result = await changeUnverifiedEmail(newEmail.trim(), newEmailAgain.trim(), password);
    setBusy(false);
    if (!result.ok) return setError(failureText(result, t));
    setPasswordText("");
    setChanging(false);
    setSent(false);
    setDone(t("unverified.changed"));
    onChanged();
  }

  return (
    <Card className="flex flex-col gap-3" data-verify-reminder>
      <Header icon={Mail} title={t("verify.reminderAction")} hint={t("verify.reminder")} />
      <p dir="ltr" className="text-xs text-muted-foreground">
        {email}
      </p>
      <Done text={done} />
      {!open ? (
        <Button variant="ghost" onClick={() => setOpen(true)} className="justify-center border border-white/10">
          {t("verify.reminderAction")}
        </Button>
      ) : changing ? (
        <form onSubmit={change} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="unverified-email">{t("unverified.newEmail")}</Label>
            <Input id="unverified-email" type="email" required value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="unverified-email-again">{t("relay.confirmEmail")}</Label>
            <Input
              id="unverified-email-again"
              type="email"
              required
              autoComplete="off"
              value={newEmailAgain}
              onChange={(e) => setNewEmailAgain(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="unverified-password">{t("settings.currentPassword")}</Label>
            <Input
              id="unverified-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPasswordText(e.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t("unverified.limit")}</p>
          <Problem text={error} />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy} className="flex-1 justify-center gap-2">
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("unverified.change")}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setChanging(false)} className="border border-white/10">
              {t("voucher.cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          {!sent ? (
            <Button onClick={() => void send()} disabled={busy} className="justify-center gap-2">
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("verify.sendCode")}
            </Button>
          ) : (
            <form onSubmit={confirm} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="reminder-code">{t("verify.code")}</Label>
                <Input
                  id="reminder-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="text-center text-lg tracking-[0.4em] tabular-nums"
                  data-ltr
                />
              </div>
              <Button type="submit" disabled={busy} className="justify-center gap-2">
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {busy ? t("verify.confirming") : t("verify.confirm")}
              </Button>
            </form>
          )}
          <Problem text={error} />
          <button
            type="button"
            onClick={() => {
              setError(null);
              setChanging(true);
            }}
            className="text-center text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {t("unverified.change")}
          </button>
        </div>
      )}
      <StillTrying waiting={busy} />
    </Card>
  );
}

/** A recovery code: create one, or replace the one held (R4.3). The
 * current password re-authenticates; an account without one is asked to
 * have signed in within fifteen minutes instead, which the backend says
 * with REAUTH_REQUIRED. The new code is shown once. */
export function RecoveryCodeSection({
  hasPassword,
  hasRecoveryCode,
  onCreated,
}: {
  hasPassword: boolean;
  hasRecoveryCode: boolean;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const result = await createRecoveryCode(hasPassword ? current : undefined);
    setBusy(false);
    if (!result.ok) return setError(failureText(result, t));
    setCurrent("");
    setCode(result.data.recoveryCode);
  }

  return (
    <Card className="flex flex-col gap-3" data-recovery-section>
      {code !== null ? (
        <RecoveryCodeNotice
          code={code}
          onSaved={() => {
            setCode(null);
            setOpen(false);
            onCreated();
          }}
        />
      ) : (
        <>
          <Header icon={KeyRound} title={t("recovery.settingsTitle")} hint={t("recovery.settingsHint")} />
          <p className="text-xs text-muted-foreground">{hasRecoveryCode ? t("recovery.has") : t("recovery.none")}</p>
          {!open ? (
            <Button variant="ghost" onClick={() => setOpen(true)} className="justify-center border border-white/10">
              {hasRecoveryCode ? t("recovery.replace") : t("recovery.create")}
            </Button>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-3">
              {hasPassword ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="recovery-current">{t("settings.currentPassword")}</Label>
                  <Input
                    id="recovery-current"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={current}
                    onChange={(e) => setCurrent(e.target.value)}
                  />
                </div>
              ) : null}
              {hasRecoveryCode ? <p className="text-xs text-muted-foreground">{t("recovery.replaceWarning")}</p> : null}
              <Problem text={error} />
              <Button type="submit" disabled={busy || (hasPassword && current.length === 0)} className="justify-center gap-2">
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {busy ? t("recovery.creating") : hasRecoveryCode ? t("recovery.replace") : t("recovery.create")}
              </Button>
            </form>
          )}
          <StillTrying waiting={busy} />
        </>
      )}
    </Card>
  );
}

/** A password for a Google, Apple or Facebook account, which has none
 * (R4.4): those providers cannot be reached during an intranet, and a
 * password is what lets the customer sign in anyway. Before any shutdown
 * is the time to set one. */
export function SetPasswordSection({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const canSubmit = next.length >= 8 && next === confirm && !busy;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const result = await setPassword(next);
    setBusy(false);
    if (!result.ok) return setError(failureText(result, t));
    setNext("");
    setConfirm("");
    setDone(true);
    onDone();
  }

  return (
    <Card className="flex flex-col gap-3" data-set-password>
      <Header icon={KeyRound} title={t("setpw.title")} hint={t("setpw.hint")} />
      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="setpw-next">{t("settings.newPassword")}</Label>
          <Input id="setpw-next" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          {next.length > 0 && next.length < 8 ? <p className="text-xs text-muted-foreground">{t("settings.tooShort")}</p> : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="setpw-confirm">{t("settings.confirmPassword")}</Label>
          <Input
            id="setpw-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {confirm.length > 0 && next !== confirm ? <p className="text-xs text-destructive">{t("settings.mismatch")}</p> : null}
        </div>
        <Problem text={error} />
        <Done text={done ? t("setpw.done") : null} />
        <Button type="submit" disabled={!canSubmit} className="justify-center gap-2">
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          {t("setpw.submit")}
        </Button>
        <StillTrying waiting={busy} />
      </form>
    </Card>
  );
}

/** The backup route's switch: on until the customer turns it off here --
 * nothing asks first (last-resort.ts). While relay mode lasts it says so,
 * and why, in the words the evidence allows (`relayDetail`). */
export function BackupRouteSection() {
  const { t } = useI18n();
  const { active, status } = useRelayMode();
  const [granted, setGranted] = useState(backupRouteOn());

  function toggle() {
    const next = !granted;
    setBackupRouteOn(next);
    setGranted(next);
  }

  // The web portal shares this screen and has no relay.
  if (!relaySupported()) return null;

  return (
    <Card className="flex flex-col gap-3" data-backup-route>
      <div className="flex items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <Route className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{t("settings.backupRoute")}</p>
          <p className="text-xs text-muted-foreground">{t("settings.backupRouteHint")}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={granted}
          aria-label={t("settings.backupRouteToggle")}
          onClick={toggle}
          className={[
            "press relative h-6 w-11 shrink-0 rounded-full border transition-colors",
            granted
              ? "border-transparent bg-[linear-gradient(120deg,var(--primary),var(--brand-2))]"
              : "border-white/12 bg-white/8",
          ].join(" ")}
        >
          <span
            className={[
              "absolute top-0.5 size-4 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.5)] transition-[inset-inline-start] duration-200",
              granted ? "start-[1.375rem]" : "start-0.5",
            ].join(" ")}
          />
        </button>
      </div>
      {active ? (
        <p className="text-xs text-muted-foreground">
          {t("settings.backupRouteInUse")} {t(relayDetail(status))}
        </p>
      ) : null}
    </Card>
  );
}
