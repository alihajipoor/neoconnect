import { useState } from "react";
import { register } from "../lib/auth";
import { Button, Card, Input, Label } from "../components/ui";
import { Logo } from "../components/Logo";
import { useI18n } from "../lib/i18n";

export function Register({
  onNeedsVerification,
  onGoLogin,
}: {
  onNeedsVerification: (email: string, password: string) => void;
  onGoLogin: () => void;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [referralCode, setReferralCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setError(null);
    setPending(true);
    const result = await register(email, password, referralCode.trim() || undefined);
    setPending(false);
    if (result.ok) {
      onNeedsVerification(email, password);
    } else {
      setError(result.error);
    }
  }

  return (
    <div className="glow-backdrop flex h-full flex-col items-center justify-center gap-8 overflow-hidden p-6">
      <Logo className="scale-110" />
      <Card className="w-full max-w-xs">
        <h1 className="mb-1 text-lg font-semibold">{t("auth.createAccount")}</h1>
        <p className="mb-4 text-sm text-muted-foreground">{t("auth.noCardRequired")}</p>
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
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending} className="mt-1 w-full">
            {pending ? t("auth.registering") : t("auth.createAccount")}
          </Button>
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
