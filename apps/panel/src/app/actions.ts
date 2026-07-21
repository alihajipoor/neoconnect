"use server";

import { redirect } from "next/navigation";
import { backendUrl } from "@/lib/backend";
import { clearSessionCookies, getAccessToken } from "@/lib/session";

export async function logoutAction() {
  const token = await getAccessToken();
  if (token) {
    // Revokes all outstanding refresh tokens server-side (bumps
    // tokenVersion) -- best-effort, we clear the local cookies either way.
    await fetch(`${backendUrl()}/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => undefined);
  }
  await clearSessionCookies();
  redirect("/login");
}
