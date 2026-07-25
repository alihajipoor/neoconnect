import { useState } from "react";
import { verifyEmailByCode, resendVerification, login } from "../lib/auth";
import { Button, Card, Input, Label } from "../components/ui";
import { Logo } from "../components/Logo";

// `password` is optional: present when this screen follows a fresh
// register()/login() attempt in the same session (lets us auto-sign-in
// the moment the code is confirmed, no second manual login needed), but
// absent if the app restarted with a pending-verification account and
// re-showed this screen from scratch. Falls back to sending the user to
// the login screen in that case.
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
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [resending, setResending] = useState(false);

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
    const result = await resendVerification(email);
    setResending(false);
    setNotice(result.ok ? "Sent! Check your inbox (and spam folder)." : null);
    if (!result.ok) setError(result.error);
  }

  return (
    <div className="glow-backdrop flex h-full flex-col items-center justify-center gap-8 overflow-hidden p-6">
      <Logo className="scale-110" />
      <Card className="w-full max-w-xs">
        <h1 className="mb-1 text-lg font-semibold">Verify your email</h1>
        <p className="mb-4 text-sm text-muted-foreground">
          We sent a 6-digit code to <span className="text-foreground">{email}</span>. Enter it below to activate
          your account.
        </p>
        <form onSubmit={handleVerify} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="code">Verification code</Label>
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
            {pending ? "Verifying..." : "Verify"}
          </Button>
        </form>
        <button
          type="button"
          onClick={() => void handleResend()}
          disabled={resending}
          className="mt-4 w-full text-center text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {resending ? "Sending..." : "Didn't get a code? Resend it"}
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
