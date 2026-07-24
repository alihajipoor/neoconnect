"use client";

import { useActionState } from "react";
import { loginAction, type LoginState } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const initialState: LoginState = {};

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);
  const mfaStep = Boolean(state.mfaToken);

  return (
    <Card className="w-full border-white/10 bg-card/80 shadow-2xl shadow-black/40 backdrop-blur-sm">
      <CardHeader>
        <CardTitle className="text-xl">{mfaStep ? "Two-factor verification" : "Welcome back"}</CardTitle>
        <CardDescription>
          {mfaStep ? "Enter the 6-digit code from your authenticator app." : "Sign in to manage your panel."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-4">
          {mfaStep ? (
            <>
              <input type="hidden" name="mfaToken" value={state.mfaToken} />
              <div className="flex flex-col gap-2">
                <Label htmlFor="code">Authentication code</Label>
                <Input
                  id="code"
                  name="code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  pattern="[0-9]{6}"
                  required
                  autoFocus
                  className="text-center text-lg tracking-[0.5em]"
                />
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </div>
            </>
          )}
          {state.error ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {state.error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending} size="lg" className="mt-2">
            {pending ? "Verifying..." : mfaStep ? "Verify" : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
