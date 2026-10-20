import { useState } from "react";
import { forgotPassword, resetPasswordByCode, resetPasswordByRecoveryCode } from "../lib/auth";
import { Message, PasswordField, PillButton, TextField, TextLink } from "../components/ui";
import { AuthFrame, AuthHead } from "../components/auth/AuthFrame";
import { useI18n } from "../lib/i18n";
import { failureText } from "../lib/failure-text";
import { StillTrying } from "../components/StillTrying";
import { RecoveryCodeNotice } from "../components/BackupRoute";

/** Getting back in after forgetting the password.
 *
 * A code rather than a link, matching the verification screen. The
 * emailed reset link carries a token in a custom URI scheme, which
 * webmail strips -- the bug that gave verification its own code path.
 * A locked-out customer is sitting in front of this app, so the code is
 * the route that actually reaches them.
 *
 * Both steps live on one screen because they are one task. Sending the
 * customer somewhere else to type the code loses the email address they
 * just entered, and asking for it twice invites the typo that makes the
 * code look wrong.
 */
export function ForgotPassword({ onDone, onCancel }: { onDone: (notice: string) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // The other way back in: the recovery code, for when the mailbox cannot
  // be reached (docs/relay-last-resort.md, R4.3). Its own form, because it
  // is a different code -- a recovery code, never the emailed reset code.
  const [byRecovery, setByRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [nextRecoveryCode, setNextRecoveryCode] = useState<string | null>(null);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const result = await forgotPassword(email);
    setPending(false);
    // Advances even on failure, and deliberately. The server answers
    // identically whether or not the address is registered, so stopping
    // here on an error would leak the difference the endpoint works to
    // hide -- and the only real failure worth reporting is the network
    // being down, which the next step surfaces anyway.
    if (!result.ok && result.error) setError(failureText(result, t));
    setSent(true);
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Checked here rather than only server-side so the customer is told
    // before spending their code on a request that cannot succeed.
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
      <AuthFrame step="forgot-recovered" label={t("recovery.title")}>
        <div className="nx-auth-recovery">
          <RecoveryCodeNotice
            code={nextRecoveryCode}
            lead={t("forgot.recoveryDone")}
            onSaved={() => onDone(t("forgot.done"))}
          />
        </div>
      </AuthFrame>
    );
  }

  const switchWay = (
    <TextLink
      onClick={() => {
        setError(null);
        setByRecovery(!byRecovery);
      }}
    >
      {byRecovery ? t("forgot.useEmail") : t("forgot.useRecovery")}
    </TextLink>
  );

  const passwords = (
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
    <AuthFrame step={byRecovery ? "forgot-recovery" : sent ? "forgot-code" : "forgot"}>
      <AuthHead title={t("forgot.title")} lead={t("forgot.subtitle")} />

      {byRecovery ? (
        <form onSubmit={handleRecovery} className="nx-form" data-recovery-reset>
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
            value={recoveryCode}
            onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}
            className="nx-code"
            dir="ltr"
          />
          {passwords}
          {error ? <Message tone="danger">{error}</Message> : null}
          <PillButton type="submit" disabled={pending} aria-busy={pending || undefined} className="nx-auth-submit">
            {pending ? t("forgot.submitting") : t("forgot.submit")}
          </PillButton>
          <StillTrying waiting={pending} />
          <div className="nx-auth-after">{switchWay}</div>
        </form>
      ) : !sent ? (
        <form onSubmit={handleSend} className="nx-form">
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
          <PillButton type="submit" disabled={pending} aria-busy={pending || undefined} className="nx-auth-submit">
            {pending ? t("forgot.sending") : t("forgot.sendCode")}
          </PillButton>
          <StillTrying waiting={pending} />
          {/* "The reset code is sent by email" -- and the way round it.
              Never "reset code" for the recovery code, or the other way
              about (docs/relay-last-resort.md, section 8). */}
          <p className="nx-auth-fine">{t("forgot.relayHint")}</p>
          <div className="nx-auth-after">{switchWay}</div>
        </form>
      ) : (
        <form onSubmit={handleReset} className="nx-form">
          {/* Worded as a conditional, because it is one -- the server
              will not say whether this address has an account, and the
              UI must not imply it did. */}
          <Message tone="neutral">{t("forgot.sent")}</Message>
          <TextField
            id="fp-code"
            label={t("forgot.code")}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="nx-code"
            dir="ltr"
            data-ltr
          />
          {passwords}
          {error ? <Message tone="danger">{error}</Message> : null}
          <PillButton type="submit" disabled={pending} aria-busy={pending || undefined} className="nx-auth-submit">
            {pending ? t("forgot.submitting") : t("forgot.submit")}
          </PillButton>
          <StillTrying waiting={pending} />
          <p className="nx-auth-fine">{t("forgot.relayHint")}</p>
          <div className="nx-auth-after">{switchWay}</div>
        </form>
      )}

      <div className="nx-auth-after">
        <TextLink strong onClick={onCancel}>
          {t("forgot.backToSignIn")}
        </TextLink>
      </div>
    </AuthFrame>
  );
}
