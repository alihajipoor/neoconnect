import { useEffect, useState } from "react";
import { verifyEmailByCode, resendVerification, login } from "../lib/auth";
import { Button, Card, Input, Label } from "../components/ui";
import { Logo } from "../components/Logo";
import { useI18n } from "../lib/i18n";

// `password` is optional: present when this screen follows a fresh
// register()/login() attempt in the same session (lets us auto-sign-in
// the moment the code is confirmed, no second manual login needed), but
// absent if the app restarted with a pending-verification account and
// re-showed this screen from scratch. Falls back to sending the user to
// the login screen in that case.
/** Login is throttled at 5 requests per 60s, so this stays well clear of
 * it while still noticing a phone-side verification within seconds. */
const VERIFICATION_POLL_MS = 20_000;

export function VerifyEmail({
  email,
  password,
  onVerified,
  onGoLogin,
}: {
  email: string;
  password?: string;
  onVerified: () => void;
  onGoLogin: () => void;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [resending, setResending] = useState(false);

  // Notices verification that happened somewhere else.
  //
  // The email's link can be opened anywhere -- most naturally on a phone,
  // which is where the email was read. Verification then completes on the
  // server while this screen sits waiting for a code forever, and the
  // code no longer works because verifying clears it. Reported exactly
  // that way: verified on a phone, app still asking, code rejected.
  //
  // Retrying the login the customer already made is the check: while
  // unverified it comes back `requiresVerification`, and the moment the
  // account is confirmed it returns real tokens. No new endpoint, and
  // nothing is disclosed that this session did not already know.
  //
  // Only possible when the password is still in memory from this
  // session's own sign-in; the restart path has nothing to poll with.
  useEffect(() => {
    if (!password) return;
    const id = setInterval(async () => {
      const result = await login(email, password);
      if (result.ok && !("requiresVerification" in result.data)) {
        clearInterval(id);
        onVerified();
      }
    }, VERIFICATION_POLL_MS);
    return () => clearInterval(id);
  }, [email, password, onVerified]);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setPending(true);

    const result = await verifyEmailByCode(email, code);
    if (!result.ok) {
      setPending(false);
      setError(result.error);
      return;
    }

    if (password) {
      const loginResult = await login(email, password);
      setPending(false);
      if (loginResult.ok && !("requiresVerification" in loginResult.data)) {
        onVerified();
        return;
      }
      // Verified but couldn't auto-sign-in for some reason (rare) --
      // don't strand the user, send them to a normal sign-in.
      onGoLogin();
      return;
    }

    setPending(false);
    onGoLogin();
  }

  async function handleResend() {
    setError(null);
    setResending(true);

    // Check whether the account is already verified before asking for
    // another email. The server answers resend with 204 either way -- it
    // deliberately refuses to reveal whether an address exists or is
    // already confirmed -- but it only actually sends to an unverified
    // one. So "Sent! Check your inbox" was a flat lie to anyone who had
    // just verified on their phone, and they waited for an email that
    // was never going to arrive. Reported exactly that way.
    if (password) {
      const check = await login(email, password);
      if (check.ok && !("requiresVerification" in check.data)) {
        setResending(false);
        onVerified();
        return;
      }
    }

    const result = await resendVerification(email);
    setResending(false);
    setNotice(result.ok ? "Sent! Check your inbox (and spam folder)." : null);
    if (!result.ok) setError(result.error);
  }

  return (
    <div className="glow-backdrop flex h-full flex-col items-center justify-center gap-8 overflow-hidden p-6">
      <Logo className="scale-110" />
      <Card className="w-full max-w-xs">
        <h1 className="mb-1 text-lg font-semibold">{t("verify.title")}</h1>
        <p className="mb-4 text-sm text-muted-foreground">
          We sent a 6-digit code to <span className="text-foreground">{email}</span>. Enter it below to activate
          your account.
        </p>
        <form onSubmit={handleVerify} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="code">{t("verify.code")}</Label>
            <Input
              id="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              pattern="[0-9]{6}"
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className="text-center text-lg tracking-[0.5em]"
            />
          </div>
          {error ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {notice ? <p className="text-xs text-success">{notice}</p> : null}
          <Button type="submit" disabled={pending || code.length !== 6} className="mt-1 w-full">
            {pending ? t("verify.confirming") : t("verify.confirm")}
          </Button>
        </form>
        <button
          type="button"
          onClick={() => void handleResend()}
          disabled={resending}
          className="mt-4 w-full text-center text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {resending ? t("verify.sending") : t("verify.noCode")}
        </button>
        <button
          type="button"
          onClick={onGoLogin}
          className="mt-2 w-full text-center text-xs text-muted-foreground hover:text-foreground"
        >
          Back to sign in
        </button>
      </Card>
    </div>
  );
}
