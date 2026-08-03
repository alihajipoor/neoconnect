import { fetch } from "@tauri-apps/plugin-http";
import { API_BASE_URL } from "./config";
import { clearTokens, getTokens, setTokens } from "./session";
import type { TokenPair } from "./types";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; sessionExpired?: boolean };

async function parseErrorMessage(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  if (Array.isArray(body?.message)) return body.message.join(", ");
  if (typeof body?.message === "string") return body.message;
  return `Request failed (${res.status})`;
}

/** Unauthenticated request -- login/register don't have a token yet. */
export async function publicRequest<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    return { ok: false, error: "Could not reach Neoxify. Check your internet connection." };
  }

  if (!res.ok) {
    return { ok: false, error: await parseErrorMessage(res) };
  }
  if (res.status === 204) return { ok: true, data: undefined as T };
  return { ok: true, data: (await res.json()) as T };
}

async function refreshTokens(): Promise<TokenPair | null> {
  const current = await getTokens();
  if (!current) return null;

  const result = await publicRequest<TokenPair>("/customer-auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken: current.refreshToken }),
  });
  if (!result.ok) return null;

  await setTokens(result.data);
  return result.data;
}

/** Authenticated request -- attaches the stored access token, and on a
 * 401 (expired access token, the normal case ~every 15 minutes) tries
 * exactly one silent refresh-and-retry before giving up. If the refresh
 * itself fails (revoked/expired refresh token), clears the stored
 * session and returns `sessionExpired: true` so the UI can drop back to
 * the login screen instead of showing a raw error. */
export async function apiRequest<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  const tokens = await getTokens();
  if (!tokens) return { ok: false, error: "Not signed in.", sessionExpired: true };

  const doFetch = (accessToken: string) =>
    fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        ...init?.headers,
      },
    });

  let res: Response;
  try {
    res = await doFetch(tokens.accessToken);
  } catch {
    return { ok: false, error: "Could not reach Neoxify. Check your internet connection." };
  }

  if (res.status === 401) {
    const refreshed = await refreshTokens();
    if (!refreshed) {
      await clearTokens();
      return { ok: false, error: "Your session expired. Please sign in again.", sessionExpired: true };
    }
    try {
      res = await doFetch(refreshed.accessToken);
    } catch {
      return { ok: false, error: "Could not reach Neoxify. Check your internet connection." };
    }
  }

  if (!res.ok) {
    return { ok: false, error: await parseErrorMessage(res) };
  }
  if (res.status === 204) return { ok: true, data: undefined as T };
  return { ok: true, data: (await res.json()) as T };
}
