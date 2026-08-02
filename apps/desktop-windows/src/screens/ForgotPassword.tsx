import { useState } from "react";
import { forgotPassword, resetPasswordByCode } from "../lib/auth";
import { Button, Card, Input, Label } from "../components/ui";
import { LogoMark } from "../components/Logo";
import { useI18n } from "../lib/i18n";

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
    if (!result.ok && result.error) setError(result.error);
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
    if (!result.ok) return setError(result.error);
    onDone(t("forgot.done"));
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm p-7">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <LogoMark className="h-10 w-10" />
          <div>
            <h1 className="text-lg font-semibold">{t("forgot.title")}</h1>
            <p className="mt-1 text-xs text-muted-foreground">{t("forgot.subtitle")}</p>
          </div>
        </div>

        {!sent ? (
          <form onSubmit={handleSend} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fp-email">{t("auth.email")}</Label>
              <Input
                id="fp-email"
                type="email"
                autoComplete="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            {error ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={pending} className="mt-1 w-full">
              {pending ? t("forgot.sending") : t("forgot.sendCode")}
            </Button>
          </form>
        ) : (
          <form onSubmit={handleReset} className="flex flex-col gap-4">
            {/* Worded as a conditional, because it is one -- the server
                will not say whether this address has an account, and the
                UI must not imply it did. */}
            <p className="rounded-md border border-primary/25 bg-primary/10 px-3 py-2 text-xs text-muted-foreground">
              {t("forgot.sent")}
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fp-code">{t("forgot.code")}</Label>
              <Input
                id="fp-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="text-center text-lg tracking-[0.4em] tabular-nums"
                data-ltr
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fp-new">{t("forgot.newPassword")}</Label>
              <Input
                id="fp-new"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fp-confirm">{t("forgot.confirmPassword")}</Label>
              <Input
                id="fp-confirm"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            {error ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={pending} className="mt-1 w-full">
              {pending ? t("forgot.submitting") : t("forgot.submit")}
            </Button>
          </form>
        )}

        <p className="mt-4 text-center text-xs">
          <button
            type="button"
            onClick={onCancel}
            className="font-medium text-primary underline-offset-2 transition-colors hover:text-highlight hover:underline"
          >
            {t("forgot.backToSignIn")}
          </button>
        </p>
      </Card>
    </div>
  );
}
