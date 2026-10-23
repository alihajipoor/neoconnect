import { useState } from "react";
import { register, relayRegister } from "@shared/lib/auth";
import { useI18n } from "@shared/lib/i18n";
import { failureText, type ShownFailure } from "@shared/lib/failure-text";
import { useStillTrying } from "@shared/lib/still-trying";
import { relayModeActive } from "@shared/lib/last-resort";
import { SocialSignIn, type PortalSocial } from "./SocialSignIn";
import { RecoveryCodeNotice } from "@shared/components/BackupRoute";
import { CardHead, RecoveryStep } from "./AuthShell";
import { Message, PasswordField, PrimaryButton, SecondaryButton, TextButton, TextField } from "./controls";
import { useCopy } from "./copy";

/**
 * Registration, as the portal draws it.
 *
 * The behaviour is the apps' screens/Register.tsx: the eight-character
 * check before anything is sent, register() with the referral code only
 * when one was typed, the backup route's own sign-up (shown at once in
 * relay mode, or offered after a sign-up that failed as only blocking
 * explains), its address typed twice and compared as the backend
 * normalises one, and the recovery code shown once. Only the markup and
 * the wording of the short-password line (now in the reader's language)
 * are the portal's.
 */
export function PortalRegister({
  onNeedsVerification,
  onSuccess,
  onGoLogin,
  onRelaySignedUp,
  social,
}: {
  onNeedsVerification: (email: string, password: string) => void;
  /** A provider sign-up ends with a usable session; the password form
   * never takes this path. */
  onSuccess: () => void;
  onGoLogin: () => void;
  /** Where a backup-route sign-up goes once its recovery code is saved.
   * Falls back to `onSuccess`. */
  onRelaySignedUp?: () => void;
  /** A Google or Facebook sign-up the page came back from, if any. */
  social?: PortalSocial;
}) {
  const { t } = useI18n();
  const copy = useCopy();
  const [email, setEmail] = useState("");
  const [emailAgain, setEmailAgain] = useState("");
  const [password, setPassword] = useState("");
  const [referralCode, setReferralCode] = useState("");
  // Kept as it came, and worded as the screen renders (`ShownFailure`).
  const [error, setError] = useState<ShownFailure | null>(null);
  const [pending, setPending] = useState(false);
  // The backup route's own sign-up: shown at once while relay mode says
  // the usual routes are blocked here, or offered after a sign-up that
  // failed as only blocking explains (`relaySignup` in auth.ts).
  const [viaRelay, setViaRelay] = useState(() => relayModeActive());
  const [relayOffered, setRelayOffered] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const pendingLong = useStillTrying(pending);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError({ error: copy.passwordTooShort });
      return;
    }
    setError(null);
    setPending(true);
    const result = await register(email, password, referralCode.trim() || undefined);
    setPending(false);
    if (result.ok) {
      onNeedsVerification(email, password);
    } else {
      setError(result);
      if (result.relaySignup) setRelayOffered(true);
    }
  }

  async function handleRelaySubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError({ error: t("forgot.tooShort") });
      return;
    }
    // Typed twice because nothing else confirms it: a typo here is a paid
    // account nobody can ever verify (F9). Compared as the backend
    // normalises an address.
    if (email.trim().toLowerCase() !== emailAgain.trim().toLowerCase()) {
      setError({ error: t("relay.emailMismatch") });
      return;
    }
    setError(null);
    setPending(true);
    const result = await relayRegister(email.trim(), emailAgain.trim(), password);
    setPending(false);
    if (result.ok) setRecoveryCode(result.data.recoveryCode);
    else setError(result);
  }

  const backToSignIn = (
    <div className="pa-after">
      <p className="pa-switch">
        {t("auth.haveAccount")}{" "}
        <TextButton className="pa-link-strong" onClick={onGoLogin}>
          {t("auth.signIn")}
        </TextButton>
      </p>
    </div>
  );

  if (recoveryCode !== null) {
    return (
      <RecoveryStep>
        <RecoveryCodeNotice code={recoveryCode} onSaved={() => (onRelaySignedUp ?? onSuccess)()} />
      </RecoveryStep>
    );
  }

  if (viaRelay) {
    return (
      <>
        {/* Neutral, not a warning: nothing is wrong with the customer's
            account, only with the network between us. */}
        <CardHead title={t("relay.signupTitle")} lead={<span data-relay-signup-note>{t("relay.signupNote")}</span>} />
        <form onSubmit={handleRelaySubmit} method="post" className="pa-form">
          <TextField
            id="relay-email"
            label={t("auth.email")}
            type="email"
            autoComplete="email"
            required
            autoFocus
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <TextField
            id="relay-email-again"
            label={t("relay.confirmEmail")}
            type="email"
            autoComplete="off"
            required
            dir="ltr"
            value={emailAgain}
            onChange={(e) => setEmailAgain(e.target.value)}
          />
          <PasswordField
            id="relay-password"
            label={t("auth.password")}
            hint={t("forgot.tooShort")}
            autoComplete="new-password"
            minLength={8}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error ? <Message tone="danger">{failureText(error, t)}</Message> : null}
          <PrimaryButton type="submit" disabled={pending} busy={pending}>
            {pending ? t("auth.registering") : t("auth.createAccount")}
          </PrimaryButton>
          {pendingLong ? (
            <p className="pa-note" role="status">
              {t("common.stillTrying")}
            </p>
          ) : null}
        </form>
        {backToSignIn}
      </>
    );
  }

  return (
    <>
      <CardHead title={t("auth.createAccount")} lead={t("auth.noCardRequired")} />
      <SocialSignIn social={social} from="register" onSuccess={onSuccess} disabled={pending} />
      <form onSubmit={handleSubmit} method="post" className="pa-form">
        <TextField
          id="email"
          label={t("auth.email")}
          type="email"
          autoComplete="email"
          required
          autoFocus
          dir="ltr"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <PasswordField
          id="password"
          label={t("auth.password")}
          hint={t("forgot.tooShort")}
          autoComplete="new-password"
          minLength={8}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {/* Optional, and labelled as such. A mistyped code is refused by
            the server rather than silently ignored. */}
        <TextField
          id="referralCode"
          label={t("auth.referralCode")}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          dir="ltr"
          placeholder={t("auth.referralCodeHint")}
          value={referralCode}
          onChange={(e) => setReferralCode(e.target.value)}
        />
        {error ? <Message tone="danger">{failureText(error, t)}</Message> : null}
        <PrimaryButton type="submit" disabled={pending} busy={pending}>
          {pending ? t("auth.registering") : t("auth.createAccount")}
        </PrimaryButton>
        {pendingLong ? (
          <p className="pa-note" role="status">
            {t("common.stillTrying")}
          </p>
        ) : null}
        {/* Only after a sign-up that failed as only blocking explains, on
            a device with evidence it is in Iran -- and nothing has been
            sent to the relay to know that. */}
        {relayOffered ? (
          <SecondaryButton
            type="button"
            onClick={() => {
              setError(null);
              setViaRelay(true);
            }}
          >
            {t("relay.offerSignup")}
          </SecondaryButton>
        ) : null}
      </form>
      {backToSignIn}
    </>
  );
}
