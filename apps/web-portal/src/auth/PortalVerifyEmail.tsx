import { useEffect, useState } from "react";
import { verifyEmailByCode, resendVerification, login } from "@shared/lib/auth";
import { useI18n } from "@shared/lib/i18n";
import { failureText } from "@shared/lib/failure-text";
import { StillTrying } from "@shared/components/StillTrying";
import { CardHead } from "./AuthShell";
import { Message, PrimaryButton, TextButton, TextField } from "./controls";
import { useCopy } from "./copy";
import { toLatinDigits } from "./digits";

/** Login is throttled at 5 requests per 60s, so this stays well clear of
 * it while still noticing a phone-side verification within seconds. The
 * same interval as the apps' screens/VerifyEmail.tsx. */
const VERIFICATION_POLL_MS = 20_000;

/**
 * The six-digit code after a sign-up, as the portal draws it.
 *
 * The behaviour is the apps' screens/VerifyEmail.tsx: it notices a
 * verification made elsewhere (the email's link opened on a phone) by
 * retrying the sign-in this session already made; a confirmed code signs
 * straight in when the password is still in memory and sends the visitor
 * to sign in when it is not; and "Resend" first checks whether the
 * account is already confirmed, because the server answers a resend the
 * same either way and "Sent!" would otherwise be a lie. Only the markup,
 * and the two sentences that were hard-coded English there, are the
 * portal's.
 */
export function PortalVerifyEmail({
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
  const copy = useCopy();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [resending, setResending] = useState(false);

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
      setError(failureText(result, t));
      return;
    }

    if (password) {
      const loginResult = await login(email, password);
      setPending(false);
      if (loginResult.ok && !("requiresVerification" in loginResult.data)) {
        onVerified();
        return;
      }
      // Verified but couldn't sign in for some reason (rare) -- don't
      // strand the visitor, send them to a normal sign-in.
      onGoLogin();
      return;
    }

    setPending(false);
    onGoLogin();
  }

  async function handleResend() {
    setError(null);
    setResending(true);

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
    setNotice(result.ok ? copy.resent : null);
    if (!result.ok) setError(failureText(result, t));
  }

  // The address sits inside a Persian sentence as well as an English one,
  // so it is isolated left-to-right rather than left to the bidi
  // algorithm, which would move its punctuation.
  const [before, after] = copy.verifyLead.split("{email}");
  const lead = (
    <>
      {before}
      <bdi dir="ltr" className="pa-strong">
        {email}
      </bdi>
      {after}
    </>
  );

  return (
    <>
      <CardHead title={t("verify.title")} lead={lead} />
      <form onSubmit={handleVerify} method="post" className="pa-form">
        <TextField
          id="code"
          label={t("verify.code")}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          pattern="[0-9]{6}"
          required
          autoFocus
          dir="ltr"
          className="pa-code"
          value={code}
          // Persian digits typed as the ASCII the code is (./digits.ts).
          onChange={(e) => setCode(toLatinDigits(e.target.value).replace(/\D/g, ""))}
        />
        {error ? <Message tone="danger">{error}</Message> : null}
        {notice ? <Message tone="ok">{notice}</Message> : null}
        <PrimaryButton type="submit" disabled={pending || code.length !== 6} busy={pending}>
          {pending ? t("verify.confirming") : t("verify.confirm")}
        </PrimaryButton>
        <StillTrying waiting={pending || resending} className="pa-note" />
      </form>
      <div className="pa-after">
        <TextButton onClick={() => void handleResend()} disabled={resending}>
          {resending ? t("verify.sending") : t("verify.noCode")}
        </TextButton>
        <TextButton onClick={onGoLogin}>{t("forgot.backToSignIn")}</TextButton>
      </div>
    </>
  );
}
