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

/** One page of a list route, plus how many rows exist behind it.
 *
 * The API's list routes return a bare JSON array and report the total in
 * an `X-Total-Count` header -- see `apps/backend/src/common/pagination.ts`
 * for why the count is not in the body. `apiFetch` throws the headers
 * away, so anything that pages has to come through here instead.
 *
 * The distinction matters more than it looks. Before these routes were
 * bounded, the overview dashboard printed `customers.length` as the
 * customer count; reading a page's length as a total would have turned
 * that headline figure into the page size, which reads as correct and is
 * not. `total` is the only honest source for a count.
 */
export interface ListPage<T> {
  items: T[];
  total: number;
}

export async function apiFetchList<T>(path: string, init?: RequestInit): Promise<ListPage<T>> {
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

  const items = (await res.json()) as T[];
  // Falls back to the page length only when the header is absent, which
  // means the route is one that has not been bounded yet -- in that case
  // the array genuinely is everything and its length genuinely is the
  // total. It is never a guess at a number the server knows better.
  const header = res.headers.get("X-Total-Count");
  const total = header === null ? items.length : Number(header);
  return { items, total: Number.isFinite(total) ? total : items.length };
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
