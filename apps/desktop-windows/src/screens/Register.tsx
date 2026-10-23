import { useState } from "react";
import { register, relayRegister } from "../lib/auth";
import { Message, PasswordField, PillButton, TextField, TextLink } from "../components/ui";
import { AuthFrame, AuthHead, type AuthSeed } from "../components/auth/AuthFrame";
import { useI18n } from "../lib/i18n";
import { failureText, type ShownFailure } from "../lib/failure-text";
import { useStillTrying } from "../lib/still-trying";
import { relayModeActive } from "../lib/last-resort";
import { SocialSignIn } from "../components/SocialSignIn";
import { RecoveryCodeNotice } from "../components/BackupRoute";

export function Register({
  onNeedsVerification,
  onSuccess,
  onGoLogin,
  onRelaySignedUp,
  seed,
}: {
  onNeedsVerification: (email: string, password: string) => void;
  /** A signup through a provider ends with a usable session, not a
   * verification step: the provider has already proven the address, so
   * mailing a code to it would only lose people. That is why this
   * screen has a success path at all -- the password form below never
   * takes it. */
  onSuccess: () => void;
  onGoLogin: () => void;
  /** A sign-up through the relay of last resort ends with a usable session
   * whose address is unconfirmed: it can take an Ultimate voucher and
   * little else until it is confirmed (docs/relay-last-resort.md, R3).
   * Where to go once its recovery code has been saved -- somewhere a
   * voucher can be entered. Falls back to `onSuccess`. */
  onRelaySignedUp?: () => void;
  /** DEV ONLY (`AuthSeed`): the preview's states. */
  seed?: AuthSeed;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [emailAgain, setEmailAgain] = useState("");
  const [password, setPassword] = useState("");
  const [referralCode, setReferralCode] = useState("");
  // Kept as it came, and worded as the screen renders (`ShownFailure`).
  const [error, setError] = useState<ShownFailure | null>(seed?.error ?? null);
  const [pending, setPending] = useState(false);
  // The backup route's own sign-up: shown at once while relay mode says
  // the usual routes are blocked here, or offered after a sign-up that
  // failed as only blocking explains (`relaySignup` in auth.ts).
  const [viaRelay, setViaRelay] = useState(() => relayModeActive());
  const [relayOffered, setRelayOffered] = useState(seed?.relayOffered ?? false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  // Sign-up is raced and timed as sign-in is (auth.ts): up to forty-six
  // and a half seconds on the network, with a line past eight saying it is
  // still trying.
  const pendingLong = useStillTrying(pending);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      // In the app's language: it was hard-coded English.
      setError({ error: t("forgot.tooShort") });
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

  const toSignIn = (
    <div className="nx-auth-after">
      <p>
        {t("auth.haveAccount")}{" "}
        <TextLink strong onClick={onGoLogin}>
          {t("auth.signIn")}
        </TextLink>
      </p>
    </div>
  );

  if (recoveryCode !== null) {
    return (
      <AuthFrame step="register-recovery" label={t("recovery.title")}>
        <div className="nx-auth-recovery">
          <RecoveryCodeNotice code={recoveryCode} onSaved={() => (onRelaySignedUp ?? onSuccess)()} />
        </div>
      </AuthFrame>
    );
  }

  if (viaRelay) {
    return (
      <AuthFrame step="register-relay">
        {/* Neutral, not a warning: nothing is wrong with the customer's
            account, only with the network between us. */}
        <AuthHead title={t("relay.signupTitle")} lead={<span data-relay-signup-note>{t("relay.signupNote")}</span>} />
        <form onSubmit={handleRelaySubmit} className="nx-form">
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
          <PillButton type="submit" disabled={pending} aria-busy={pending || undefined} className="nx-auth-submit">
            {pending ? t("auth.registering") : t("auth.createAccount")}
          </PillButton>
          {pendingLong ? <p className="text-center text-xs text-muted-foreground">{t("common.stillTrying")}</p> : null}
        </form>
        {toSignIn}
      </AuthFrame>
    );
  }

  return (
    <AuthFrame step="register">
      <AuthHead title={t("auth.createAccount")} lead={t("auth.noCardRequired")} />
      <SocialSignIn onSuccess={onSuccess} disabled={pending} providers={seed?.providers} />
      <form onSubmit={handleSubmit} className="nx-form">
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
        {/* Optional, and labelled as such. It is the only field here
            somebody can get wrong without knowing -- a mistyped code
            is refused by the server rather than silently ignored,
            because losing a friend their reward invisibly is worse
            than one more thing to correct. */}
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
        <PillButton type="submit" disabled={pending} aria-busy={pending || undefined} className="nx-auth-submit">
          {pending ? t("auth.registering") : t("auth.createAccount")}
        </PillButton>
        {pendingLong ? <p className="text-center text-xs text-muted-foreground">{t("common.stillTrying")}</p> : null}
        {/* Only after a sign-up that failed as only blocking explains, on
            a device with evidence it is in Iran -- and nothing has been
            sent to the relay to know that. */}
        {relayOffered ? (
          <PillButton
            variant="ghost"
            onClick={() => {
              setError(null);
              setViaRelay(true);
            }}
            className="nx-auth-submit"
          >
            {t("relay.offerSignup")}
          </PillButton>
        ) : null}
      </form>
      {toSignIn}
    </AuthFrame>
  );
}
