"use server";

import { redirect } from "next/navigation";
import { backendUrl } from "@/lib/backend";
import { forwardedClientHeaders } from "@/lib/client-address";
import { parseSolution, type Challenge } from "@/lib/pow";
import { setSessionCookies } from "@/lib/session";
import { type Counted, mfaFailure, passwordFailure } from "./outcome";

export interface LoginState {
  error?: string;
  // Set once the password step succeeds but the account has MFA enabled --
  // the form re-renders as a code-entry step and resubmits this alongside
  // the 6-digit code (see login-form.tsx). Absent -> we're on the
  // email/password step.
  mfaToken?: string;
}

/**
 * A proof-of-work challenge for the password step, priced by the backend
 * against this account's and this browser's recent failures.
 *
 * Fetched through the panel rather than by the browser from /api/, so that
 * the address the backend prices it for is the same one the sign-in is
 * then counted against (see forwardedClientHeaders), and so it works where
 * the panel has no /api/ in front of it (local development). Solved in the
 * browser (login-form.tsx).
 *
 * Undefined when the backend cannot be asked: the sign-in then goes
 * without a solution, which LoginGuard accepts until there have been
 * recent failures, and refuses with a message after that.
 */
export async function requestLoginChallenge(email: string): Promise<Challenge | undefined> {
  try {
    const res = await fetch(`${backendUrl()}/login-challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await forwardedClientHeaders()) },
      // The email prices the challenge against that account's recent
      // failures; LoginGuard's DTO refuses a malformed one, so it is sent
      // only when it looks like an address.
      body: JSON.stringify({ scope: "admin", ...(email.includes("@") ? { email: email.trim() } : {}) }),
      cache: "no-store",
    });
    if (!res.ok) return undefined;
    return (await res.json()) as Challenge;
  } catch {
    return undefined;
  }
}

export async function loginAction(prevState: LoginState, formData: FormData): Promise<LoginState> {
  const mfaToken = String(formData.get("mfaToken") ?? "");

  if (mfaToken) {
    return verifyMfaStep(mfaToken, formData);
  }
  return passwordStep(formData);
}

async function passwordStep(formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const challenge = parseSolution(formData.get("challenge"));

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  const forwarded = await forwardedClientHeaders();
  let res: Response;
  try {
    res = await fetch(`${backendUrl()}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...forwarded },
      body: JSON.stringify({ email, password, ...(challenge ? { challenge } : {}) }),
      cache: "no-store",
    });
  } catch {
    return { error: "Could not reach the backend. Please try again." };
  }

  if (!res.ok) {
    return { error: passwordFailure(res.status, await res.json().catch(() => null), countedAs(forwarded)) };
  }

  const body = (await res.json()) as
    | { accessToken: string; refreshToken: string }
    | { mfaRequired: true; mfaToken: string };

  if ("mfaRequired" in body) {
    return { mfaToken: body.mfaToken };
  }

  await setSessionCookies(body);
  redirect("/overview");
}

async function verifyMfaStep(mfaToken: string, formData: FormData): Promise<LoginState> {
  const code = String(formData.get("code") ?? "").trim();
  if (!code) {
    return { error: "Enter the 6-digit code from your authenticator app.", mfaToken };
  }

  const forwarded = await forwardedClientHeaders();
  let res: Response;
  try {
    res = await fetch(`${backendUrl()}/auth/mfa/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...forwarded },
      body: JSON.stringify({ mfaToken, code }),
      cache: "no-store",
    });
  } catch {
    return { error: "Could not reach the backend. Please try again.", mfaToken };
  }

  if (!res.ok) {
    // Dropping mfaToken from the returned state sends the form back to the
    // password step -- right for an expired challenge or a locked code
    // step, wrong for a mistyped code.
    const failure = mfaFailure(res.status, await res.json().catch(() => null), countedAs(forwarded));
    return failure.keepToken ? { error: failure.error, mfaToken } : { error: failure.error };
  }

  const { accessToken, refreshToken } = (await res.json()) as { accessToken: string; refreshToken: string };
  await setSessionCookies({ accessToken, refreshToken });
  redirect("/overview");
}

/** Whether the backend's per-address limits were this browser's or the
 * panel's shared one (see Counted in outcome.ts). */
function countedAs(forwarded: Record<string, string>): Counted {
  return "X-Forwarded-For" in forwarded ? "yours" : "shared";
}
