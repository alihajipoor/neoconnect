"use server";

import { redirect } from "next/navigation";
import { backendUrl } from "@/lib/backend";
import { setSessionCookies } from "@/lib/session";

export interface LoginState {
  error?: string;
  // Set once the password step succeeds but the account has MFA enabled --
  // the form re-renders as a code-entry step and resubmits this alongside
  // the 6-digit code (see login-form.tsx). Absent -> we're on the
  // email/password step.
  mfaToken?: string;
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

  if (!email || !password) {
    return { error: "Email and password are required." };
  }

  let res: Response;
  try {
    res = await fetch(`${backendUrl()}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      cache: "no-store",
    });
  } catch {
    return { error: "Could not reach the backend. Please try again." };
  }

  if (!res.ok) {
    return { error: "Invalid email or password." };
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

  let res: Response;
  try {
    res = await fetch(`${backendUrl()}/auth/mfa/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mfaToken, code }),
      cache: "no-store",
    });
  } catch {
    return { error: "Could not reach the backend. Please try again.", mfaToken };
  }

  if (!res.ok) {
    // A stale/expired mfaToken (5 min TTL) should send the user back to
    // the password step rather than looping on a code that can never
    // succeed -- res.status 401 covers both "wrong code" and "expired
    // challenge"; either way, dropping mfaToken from the returned state
    // resets the form to step 1 on the next render.
    if (res.status === 401) {
      return { error: "Invalid or expired code. Please sign in again." };
    }
    return { error: "Invalid code. Please try again.", mfaToken };
  }

  const { accessToken, refreshToken } = (await res.json()) as { accessToken: string; refreshToken: string };
  await setSessionCookies({ accessToken, refreshToken });
  redirect("/overview");
}
