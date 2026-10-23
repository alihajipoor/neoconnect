import { useState } from "react";
import { login } from "@shared/lib/auth";
import { useI18n } from "@shared/lib/i18n";
import { failureText, type ShownFailure } from "@shared/lib/failure-text";
import { useStillTrying } from "@shared/lib/still-trying";
import { SocialSignIn, type PortalSocial } from "./SocialSignIn";
import { useRelayMode } from "@shared/components/BackupRoute";
import { CardHead } from "./AuthShell";
import { Message, PasswordField, PrimaryButton, TextButton, TextField } from "./controls";
import { useCopy } from "./copy";

/**
 * Sign-in, as the portal draws it.
 *
 * The behaviour is the apps' screens/Login.tsx line for line -- the same
 * login() (with its proof of work and its forty-six-second deadline), the
 * same routing of an unverified account to the code screen, the same
 * still-trying line past eight seconds, the same note during a declared
 * intranet, social sign-in above the form leading where a password
 * sign-in does. Only the markup is the portal's, and the social block,
 * which on the web leaves the page and comes back (./SocialSignIn.tsx).
 * auth-screens.test.tsx holds the two together.
 */
export function PortalLogin({
  onSuccess,
  onNeedsVerification,
  onGoRegister,
  onGoForgotPassword,
  notice,
  social,
}: {
  onSuccess: () => void;
  onNeedsVerification: (email: string, password: string) => void;
  onGoRegister: () => void;
  onGoForgotPassword: () => void;
  notice?: string | null;
  /** A Google or Facebook sign-in the page came back from, if any. */
  social?: PortalSocial;
}) {
  const { t } = useI18n();
  const copy = useCopy();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Kept as it came, and worded as the screen renders (`ShownFailure`).
  const [error, setError] = useState<ShownFailure | null>(null);
  const [pending, setPending] = useState(false);
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
    <>
      <CardHead title={t("auth.welcomeBack")} lead={copy.signInLead} />
      {notice ? <Message tone="ok">{notice}</Message> : null}
      {relayActive && relayStatus?.intranet ? (
        <Message tone="neutral" data-intranet-limits>
          {t("relay.intranetLimits")}
        </Message>
      ) : null}
      {/* A social sign-in lands straight on the account: the provider has
          already vouched for the address. */}
      <SocialSignIn social={social} from="login" onSuccess={onSuccess} disabled={pending} />
      {/* method="post": if a script ever failed to take the submit, the
          browser must not fall back to a GET that puts the password in
          the address bar, the history and the server's log. */}
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
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error ? <Message tone="danger">{failureText(error, t)}</Message> : null}
        <PrimaryButton type="submit" disabled={pending} busy={pending}>
          {pending ? t("auth.signingIn") : t("auth.signIn")}
        </PrimaryButton>
        {pendingLong ? (
          <p className="pa-note" role="status">
            {t("common.stillTrying")}
          </p>
        ) : null}
      </form>
      {/* Below the button: it is the exit for a failed sign-in, so it
          belongs where someone looks after one. */}
      <div className="pa-after">
        <TextButton onClick={onGoForgotPassword}>{t("forgot.link")}</TextButton>
        <p className="pa-switch">
          {t("auth.noAccount")}{" "}
          <TextButton className="pa-link-strong" onClick={onGoRegister}>
            {t("auth.register")}
          </TextButton>
        </p>
      </div>
    </>
  );
}
