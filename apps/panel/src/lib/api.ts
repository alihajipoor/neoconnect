import "server-only";
import { redirect } from "next/navigation";
import { backendUrl } from "./backend";
import { getAccessToken } from "./session";

/** For Server Component data reads. Redirects to /login on missing/expired
 * session or a 401 from the backend; throws (caught by Next's error
 * boundary) on any other non-2xx response, since reads have no form to
 * show a field-level error on. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  if (!token) redirect("/login");

  const res = await fetch(`${backendUrl()}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  if (res.status === 401) redirect("/login");

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${path} failed (${res.status}): ${body}`);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type MutationResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** For Server Actions (form submissions). Never throws on a 4xx from the
 * backend -- returns a MutationResult so the calling action can show the
 * error inline on the form instead of blowing up the whole page. */
export async function apiMutate<T>(path: string, init?: RequestInit): Promise<MutationResult<T>> {
  const token = await getAccessToken();
  if (!token) redirect("/login");

  let res: Response;
  try {
    res = await fetch(`${backendUrl()}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });
  } catch {
    return { ok: false, error: "Could not reach the backend. Please try again." };
  }

  if (res.status === 401) redirect("/login");

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = Array.isArray(body?.message) ? body.message.join(", ") : (body?.message ?? `Request failed (${res.status})`);
    return { ok: false, error: message };
  }

  if (res.status === 204) return { ok: true, data: undefined as T };
  return { ok: true, data: (await res.json()) as T };
}
