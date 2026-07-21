"use server";

import { redirect } from "next/navigation";
import { backendUrl } from "@/lib/backend";
import { setSessionCookies } from "@/lib/session";

export interface LoginState {
  error?: string;
}

export async function loginAction(_prevState: LoginState, formData: FormData): Promise<LoginState> {
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

  const { accessToken, refreshToken } = (await res.json()) as {
    accessToken: string;
    refreshToken: string;
  };
  await setSessionCookies({ accessToken, refreshToken });
  redirect("/customers");
}
