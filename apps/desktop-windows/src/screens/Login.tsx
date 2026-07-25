import { useState } from "react";
import { login } from "../lib/auth";
import { Button, Card, Input, Label } from "../components/ui";
import { Logo } from "../components/Logo";

export function Login({
  onSuccess,
  onNeedsVerification,
  onGoRegister,
  notice,
}: {
  onSuccess: () => void;
  onNeedsVerification: (email: string, password: string) => void;
  onGoRegister: () => void;
  notice?: string | null;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const result = await login(email, password);
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if ("requiresVerification" in result.data) {
      onNeedsVerification(email, password);
    } else {
      onSuccess();
    }
  }

  return (
    <div className="glow-backdrop flex h-full flex-col items-center justify-center gap-8 overflow-hidden p-6">
      <Logo className="scale-110" />
      <Card className="w-full max-w-xs">
        <h1 className="mb-1 text-lg font-semibold">Welcome back</h1>
        <p className="mb-4 text-sm text-muted-foreground">Sign in to connect.</p>
        {notice ? (
          <p className="mb-3 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
            {notice}
          </p>
        ) : null}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
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
            <Label htmlFor="password">Password</Label>
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
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending} className="mt-1 w-full">
            {pending ? "Signing in..." : "Sign in"}
          </Button>
        </form>
        <button
          type="button"
          onClick={onGoRegister}
          className="mt-4 w-full text-center text-xs text-muted-foreground hover:text-foreground"
        >
          New here? Create an account
        </button>
      </Card>
    </div>
  );
}
