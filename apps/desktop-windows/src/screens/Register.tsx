import { useState } from "react";
import { register, relayRegister } from "../lib/auth";
import { Button, Card, Input, Label } from "../components/ui";
import { Logo } from "../components/Logo";
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
}) {
  const { t } = useI18n();
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
  // Sign-up is raced and timed as sign-in is (auth.ts): up to forty-six
  // and a half seconds on the network, with a line past eight saying it is
  // still trying.
  const pendingLong = useStillTrying(pending);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError({ error: "Password must be at least 8 characters." });
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

  if (recoveryCode !== null) {
    return (
      <div className="glow-backdrop flex h-full flex-col items-center justify-center gap-8 overflow-hidden p-6">
        <Logo className="scale-110" />
        <Card className="w-full max-w-xs">
          <RecoveryCodeNotice code={recoveryCode} onSaved={() => (onRelaySignedUp ?? onSuccess)()} />
        </Card>
      </div>
    );
  }

  if (viaRelay) {
    return (
      <div className="glow-backdrop flex h-full flex-col items-center justify-center gap-8 overflow-hidden p-6">
        <Logo className="scale-110" />
        <Card className="w-full max-w-xs">
          <h1 className="mb-1 text-lg font-semibold">{t("relay.signupTitle")}</h1>
          {/* Neutral, not a warning: nothing is wrong with the customer's
              account, only with the network between us. */}
          <p className="mb-4 text-sm text-muted-foreground" data-relay-signup-note>
            {t("relay.signupNote")}
          </p>
          <form onSubmit={handleRelaySubmit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="relay-email">{t("auth.email")}</Label>
              <Input
                id="relay-email"
                type="email"
                autoComplete="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="relay-email-again">{t("relay.confirmEmail")}</Label>
              <Input
                id="relay-email-again"
                type="email"
                autoComplete="off"
                required
                value={emailAgain}
                onChange={(e) => setEmailAgain(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="relay-password">{t("auth.password")}</Label>
              <Input
                id="relay-password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {failureText(error, t)}
              </p>
            ) : null}
            <Button type="submit" disabled={pending} className="mt-1 w-full">
              {pending ? t("auth.registering") : t("auth.createAccount")}
            </Button>
            {pendingLong ? <p className="text-center text-xs text-muted-foreground">{t("common.stillTrying")}</p> : null}
          </form>
          <button
            type="button"
            onClick={onGoLogin}
            className="mt-4 w-full text-center text-xs text-muted-foreground hover:text-foreground"
          >
            {t("auth.haveAccount")} {t("auth.signIn")}
          </button>
        </Card>
      </div>
    );
  }

  return (
    <div className="glow-backdrop flex h-full flex-col items-center justify-center gap-8 overflow-hidden p-6">
      <Logo className="scale-110" />
      <Card className="w-full max-w-xs">
        <h1 className="mb-1 text-lg font-semibold">{t("auth.createAccount")}</h1>
        <p className="mb-4 text-sm text-muted-foreground">{t("auth.noCardRequired")}</p>
        <SocialSignIn onSuccess={onSuccess} disabled={pending} />
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">{t("auth.email")}</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">{t("auth.password")}</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {/* Optional, and labelled as such. It is the only field here
              somebody can get wrong without knowing -- a mistyped code
              is refused by the server rather than silently ignored,
              because losing a friend their reward invisibly is worse
              than one more thing to correct. */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="referralCode">{t("auth.referralCode")}</Label>
            <Input
              id="referralCode"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              dir="ltr"
              placeholder={t("auth.referralCodeHint")}
              value={referralCode}
              onChange={(e) => setReferralCode(e.target.value)}
            />
          </div>
          {error ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {failureText(error, t)}
            </p>
          ) : null}
          <Button type="submit" disabled={pending} className="mt-1 w-full">
            {pending ? t("auth.registering") : t("auth.createAccount")}
          </Button>
          {pendingLong ? <p className="text-center text-xs text-muted-foreground">{t("common.stillTrying")}</p> : null}
          {/* Only after a sign-up that failed as only blocking explains, on
              a device with evidence it is in Iran -- and nothing has been
              sent to the relay to know that. */}
          {relayOffered ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setError(null);
                setViaRelay(true);
              }}
              className="w-full justify-center border border-white/10"
            >
              {t("relay.offerSignup")}
            </Button>
          ) : null}
        </form>
        <button
          type="button"
          onClick={onGoLogin}
          className="mt-4 w-full text-center text-xs text-muted-foreground hover:text-foreground"
        >
          Already have an account? Sign in
        </button>
      </Card>
    </div>
  );
}
