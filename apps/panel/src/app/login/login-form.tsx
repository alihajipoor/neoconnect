"use client";

import { type FormEvent, Fragment, startTransition, useActionState, useState } from "react";
import { requestFormReset } from "react-dom";
import { loginAction, requestLoginChallenge, type LoginState } from "./actions";
import { solve, type Solution } from "@/lib/pow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const initialState: LoginState = {};

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, initialState);
  const [checking, setChecking] = useState(false);
  const mfaStep = Boolean(state.mfaToken);

  // The password step carries a solved proof-of-work challenge, as the
  // apps' sign-ins do. LoginGuard requires one once an account or an
  // address has recent failures; without it the panel could not sign
  // anyone into an account somebody else was failing against on purpose.
  // Solved here, in the browser, so the work falls on whoever is signing
  // in and never on the panel's server.
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    if (!mfaStep) {
      setChecking(true);
      try {
        const solution = await solveChallengeFor(String(form.get("email") ?? ""));
        if (solution) form.set("challenge", JSON.stringify(solution));
      } finally {
        setChecking(false);
      }
    }
    startTransition(() => {
      // What React does itself when it runs a form's action, and stopped
      // doing when this handler took the submit over: clear the
      // uncontrolled fields once the action settles. Without it the
      // password stayed in its <input> -- which React then reused for the
      // code step, as type="text": the admin password shown in clear in
      // the "Authentication code" box. The keyed steps below stop that
      // reuse too.
      requestFormReset(element);
      formAction(form);
    });
  }

  return (
    <Card className="w-full border-white/10 bg-card/80 shadow-2xl shadow-black/40 backdrop-blur-sm">
      <CardHeader>
        <CardTitle className="text-xl">{mfaStep ? "Two-factor verification" : "Welcome back"}</CardTitle>
        <CardDescription>
          {mfaStep ? "Enter the 6-digit code from your authenticator app." : "Sign in to manage your panel."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* `action` as well as `onSubmit`, though onSubmit does the
            submitting once the page has hydrated. `action` is what makes
            the server render `method="POST"` and the action's hidden
            fields (login-form.test.tsx). Without it the server-rendered
            form had neither, and a submit before the script loaded (a
            slow or filtered link, Enter right after autofill) was a
            native GET with the admin password in the URL -- and so in
            nginx's access log. Before hydration the form posts to
            loginAction with no solved challenge, which the backend
            accepts until there have been recent failures. After
            hydration React does not also run `action`: onSubmit calls
            preventDefault() before its first await, and React's form
            handling skips a submit that is already prevented. */}
        <form action={formAction} onSubmit={onSubmit} className="flex flex-col gap-4">
          {/* Keyed so that changing step replaces the fields rather than
              reusing one step's <input> elements, and what was typed into
              them, for the other's. */}
          {mfaStep ? (
            <Fragment key="code-step">
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
            </Fragment>
          ) : (
            <Fragment key="password-step">
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
            </Fragment>
          )}
          {state.error ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {state.error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending || checking} size="lg" className="mt-2">
            {checking ? "Running security check..." : pending ? "Verifying..." : mfaStep ? "Verify" : "Sign in"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** Best effort, as in the apps: with no solution the sign-in still goes,
 * and the backend says plainly if it needed one. */
async function solveChallengeFor(email: string): Promise<Solution | undefined> {
  try {
    const challenge = await requestLoginChallenge(email);
    return challenge ? await solve(challenge) : undefined;
  } catch {
    return undefined;
  }
}
