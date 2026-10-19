import { useState } from "react";
import { forgotPassword, resetPasswordByCode, resetPasswordByRecoveryCode } from "@shared/lib/auth";
import { useI18n } from "@shared/lib/i18n";
import { failureText } from "@shared/lib/failure-text";
import { StillTrying } from "@shared/components/StillTrying";
import { RecoveryCodeNotice } from "@shared/components/BackupRoute";
import { CardHead } from "./AuthShell";
import { Message, PasswordField, PrimaryButton, TextButton, TextField } from "./controls";

/**
 * Getting back in after forgetting the password, as the portal draws it.
 *
 * The behaviour is the apps' screens/ForgotPassword.tsx: a code rather
 * than a link; the step advances whether or not the address is
 * registered, because the server answers both the same and stopping on
 * an error would leak the difference; the length and match checks run
 * before a code is spent; and the recovery code is the way round a
 * mailbox that cannot be reached, its successor shown once. Only the
 * markup is the portal's.
 */
export function PortalForgotPassword({ onDone, onCancel }: { onDone: (notice: string) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [byRecovery, setByRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [nextRecoveryCode, setNextRecoveryCode] = useState<string | null>(null);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const result = await forgotPassword(email);
    setPending(false);
    // Advances even on failure, and deliberately: see above.
    if (!result.ok && result.error) setError(failureText(result, t));
    setSent(true);
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError(t("forgot.tooShort"));
    if (password !== confirm) return setError(t("forgot.mismatch"));
    setPending(true);
    const result = await resetPasswordByCode(email, code.trim(), password);
    setPending(false);
    if (!result.ok) return setError(failureText(result, t));
    onDone(t("forgot.done"));
  }

  async function handleRecovery(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError(t("forgot.tooShort"));
    if (password !== confirm) return setError(t("forgot.mismatch"));
    setPending(true);
    const result = await resetPasswordByRecoveryCode(email.trim(), recoveryCode.trim(), password);
    setPending(false);
    if (!result.ok) return setError(failureText(result, t));
    // Spent: the backend hands back the next one, shown once.
    setNextRecoveryCode(result.data.recoveryCode);
  }

  if (nextRecoveryCode !== null) {
    return (
      <div className="pa-recovery">
        <h1 id="pa-title" className="pa-sr">
          {t("recovery.title")}
        </h1>
        <RecoveryCodeNotice
          code={nextRecoveryCode}
          lead={t("forgot.recoveryDone")}
          onSaved={() => onDone(t("forgot.done"))}
        />
      </div>
    );
  }

  const switchWay = (
    <TextButton
      onClick={() => {
        setError(null);
        setByRecovery(!byRecovery);
      }}
    >
      {byRecovery ? t("forgot.useEmail") : t("forgot.useRecovery")}
    </TextButton>
  );

  const newPasswordFields = (
    <>
      <PasswordField
        id="fp-new"
        label={t("forgot.newPassword")}
        hint={t("forgot.tooShort")}
        autoComplete="new-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <PasswordField
        id="fp-confirm"
        label={t("forgot.confirmPassword")}
        autoComplete="new-password"
        required
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
    </>
  );

  return (
    <>
      <CardHead title={t("forgot.title")} lead={t("forgot.subtitle")} />

      {byRecovery ? (
        <form onSubmit={handleRecovery} method="post" className="pa-form" data-recovery-reset>
          <TextField
            id="fp-email"
            label={t("auth.email")}
            type="email"
            autoComplete="email"
            required
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <TextField
            id="fp-recovery"
            label={t("forgot.recoveryCode")}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            required
            dir="ltr"
            className="pa-mono"
            value={recoveryCode}
            onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}
          />
          {newPasswordFields}
          {error ? <Message tone="danger">{error}</Message> : null}
          <PrimaryButton type="submit" disabled={pending} busy={pending}>
            {pending ? t("forgot.submitting") : t("forgot.submit")}
          </PrimaryButton>
          <StillTrying waiting={pending} className="pa-note" />
          <div className="pa-after">{switchWay}</div>
        </form>
      ) : !sent ? (
        <form onSubmit={handleSend} method="post" className="pa-form">
          <TextField
            id="fp-email"
            label={t("auth.email")}
            type="email"
            autoComplete="email"
            required
            autoFocus
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {error ? <Message tone="danger">{error}</Message> : null}
          <PrimaryButton type="submit" disabled={pending} busy={pending}>
            {pending ? t("forgot.sending") : t("forgot.sendCode")}
          </PrimaryButton>
          <StillTrying waiting={pending} className="pa-note" />
          {/* "The reset code is sent by email" -- and the way round it.
              Never "reset code" for the recovery code, or the other way
              about (docs/relay-last-resort.md, section 8). */}
          <p className="pa-fine">{t("forgot.relayHint")}</p>
          <div className="pa-after">{switchWay}</div>
        </form>
      ) : (
        <form onSubmit={handleReset} method="post" className="pa-form">
          {/* Worded as a conditional, because it is one -- the server will
              not say whether this address has an account. */}
          <Message tone="neutral">{t("forgot.sent")}</Message>
          <TextField
            id="fp-code"
            label={t("forgot.code")}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            autoFocus
            dir="ltr"
            className="pa-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          {newPasswordFields}
          {error ? <Message tone="danger">{error}</Message> : null}
          <PrimaryButton type="submit" disabled={pending} busy={pending}>
            {pending ? t("forgot.submitting") : t("forgot.submit")}
          </PrimaryButton>
          <StillTrying waiting={pending} className="pa-note" />
          <p className="pa-fine">{t("forgot.relayHint")}</p>
          <div className="pa-after">{switchWay}</div>
        </form>
      )}

      <div className="pa-after">
        <TextButton className="pa-link-strong" onClick={onCancel}>
          {t("forgot.backToSignIn")}
        </TextButton>
      </div>
    </>
  );
}
