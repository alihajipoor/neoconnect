import { useState } from "react";
import { login } from "../lib/auth";
import { Button, Card, Input, Label } from "../components/ui";
import { LogoMark } from "../components/Logo";
import { useI18n } from "../lib/i18n";
import { failureText, type ShownFailure } from "../lib/failure-text";
import { useStillTrying } from "../lib/still-trying";
import { SocialSignIn } from "../components/SocialSignIn";

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
    <div className="glow-backdrop flex h-full flex-col items-center justify-center gap-7 overflow-hidden p-6">
      {/* The mark at hero scale rather than the small nav lockup -- this
          is the first screen anyone sees, and it was previously carrying
          the same 32px logo used in a toolbar. */}
      <div className="animate-rise flex flex-col items-center gap-3">
        <LogoMark className="size-16" />
        <span className="text-brand-gradient text-2xl font-semibold tracking-tight">Neoxify</span>
      </div>

      <Card className="animate-rise w-full max-w-xs" style={{ animationDelay: "90ms" }}>
        <h1 className="mb-1 text-lg font-semibold">{t("auth.welcomeBack")}</h1>
        <p className="mb-4 text-sm text-muted-foreground">{t("auth.signInToConnect")}</p>
        {notice ? (
          <p className="mb-3 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
            {notice}
          </p>
        ) : null}
        {/* A social sign-in lands straight on the dashboard: the
            provider has already vouched for the address, so there is no
            verification step to send anyone to. */}
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
              autoComplete="current-password"
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
            {pending ? t("auth.signingIn") : t("auth.signIn")}
          </Button>
          {pendingLong ? <p className="text-center text-xs text-muted-foreground">{t("common.stillTrying")}</p> : null}
        </form>
        {/* Below the button rather than beside the password field: it is
            the exit for a failed sign-in, so it belongs where someone
            looks after one, not where they look while typing. */}
        <p className="mt-3 text-center text-xs">
          <button
            type="button"
            onClick={onGoForgotPassword}
            className="text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            {t("forgot.link")}
          </button>
        </p>
        {/* Was hardcoded English, so it stayed English in Persian mode --
            the keys for both halves already existed. */}
        <p className="mt-4 text-center text-xs text-muted-foreground">
          {t("auth.noAccount")}{" "}
          <button
            type="button"
            onClick={onGoRegister}
            className="font-medium text-primary underline-offset-2 transition-colors hover:text-highlight hover:underline"
          >
            {t("auth.register")}
          </button>
        </p>
      </Card>
    </div>
  );
}
