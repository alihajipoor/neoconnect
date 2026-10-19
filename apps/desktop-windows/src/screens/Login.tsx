import { useState } from "react";
import { login } from "../lib/auth";
import { Message, PasswordField, PillButton, TextField, TextLink } from "../components/ui";
import { AuthFrame, AuthHead } from "../components/auth/AuthFrame";
import { useI18n } from "../lib/i18n";
import { failureText, type ShownFailure } from "../lib/failure-text";
import { useStillTrying } from "../lib/still-trying";
import { SocialSignIn } from "../components/SocialSignIn";
import { useRelayMode } from "../components/BackupRoute";

export function Login({
  onSuccess,
  onNeedsVerification,
  onGoRegister,
  onGoForgotPassword,
  notice,
}: {
  onSuccess: () => void;
  onNeedsVerification: (email: string, password: string) => void;
  onGoRegister: () => void;
  onGoForgotPassword: () => void;
  notice?: string | null;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Kept as it came, and worded as the screen renders (`ShownFailure`).
  const [error, setError] = useState<ShownFailure | null>(null);
  const [pending, setPending] = useState(false);
  // A sign-in may spend up to forty-six and a half seconds on the network
  // where only a slow route answers (`SIGN_IN_DEADLINE_MS` in auth.ts),
  // more while a hard proof of work is solved; past eight the button's "Signing in..." gets a
  // line saying it is still trying.
  const pendingLong = useStillTrying(pending);
  // During a declared intranet, what will not work is said before it is
  // tried (docs/relay-last-resort.md, R4.4) -- only when declared (I4).
  const { active: relayActive, status: relayStatus } = useRelayMode();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const result = await login(email, password);
    setPending(false);
    if (!result.ok) {
      setError(result);
      return;
    }
    if ("requiresVerification" in result.data) {
      onNeedsVerification(email, password);
    } else {
      onSuccess();
    }
  }

  return (
    <AuthFrame step="login">
      <AuthHead title={t("auth.welcomeBack")} lead={t("auth.signInToConnect")} />
      {notice ? <Message tone="neutral">{notice}</Message> : null}
      {relayActive && relayStatus?.intranet ? (
        // Neutral: nothing is wrong with the account, only with the network.
        <Message tone="neutral" data-intranet-limits>
          {t("relay.intranetLimits")}
        </Message>
      ) : null}
      {/* A social sign-in lands straight on the dashboard: the
          provider has already vouched for the address, so there is no
          verification step to send anyone to. */}
      <SocialSignIn onSuccess={onSuccess} disabled={pending} />
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
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error ? <Message tone="danger">{failureText(error, t)}</Message> : null}
        <PillButton type="submit" disabled={pending} aria-busy={pending || undefined} className="nx-auth-submit">
          {pending ? t("auth.signingIn") : t("auth.signIn")}
        </PillButton>
        {pendingLong ? <p className="text-center text-xs text-muted-foreground">{t("common.stillTrying")}</p> : null}
      </form>
      <div className="nx-auth-after">
        {/* Below the button rather than beside the password field: it is
            the exit for a failed sign-in, so it belongs where someone
            looks after one, not where they look while typing. */}
        <TextLink onClick={onGoForgotPassword}>{t("forgot.link")}</TextLink>
        <p>
          {t("auth.noAccount")}{" "}
          <TextLink strong onClick={onGoRegister}>
            {t("auth.register")}
          </TextLink>
        </p>
      </div>
    </AuthFrame>
  );
}
