import { NextResponse, type NextRequest } from "next/server";
import { backendUrl } from "@/lib/backend";
import { ACCESS_COOKIE, REFRESH_COOKIE, cookieOptions, needsRenewal } from "@/lib/session-tokens";

/** Sliding admin sessions.
 *
 * The access token lasts minutes. Before this the panel never used the
 * refresh token it was given, so every session ended at the access
 * token's expiry however busy the person was -- while the refresh cookie
 * sat in the browser for a week, good for renewing at the API.
 *
 * Now, on any request whose access token is missing or about to expire,
 * the refresh token is exchanged for a new pair, and the new access token
 * is handed to this same request as well as stored. The backend decides
 * how long that can go on: an idle limit each renewal moves out, and a cap
 * from the sign-in that it does not. Once it refuses, the refresh cookie
 * is dropped and the page sends the person to sign in. */
export async function proxy(request: NextRequest) {
  const access = request.cookies.get(ACCESS_COOKIE)?.value;
  const refresh = request.cookies.get(REFRESH_COOKIE)?.value;
  if (!refresh || !needsRenewal(access, refresh)) return NextResponse.next();

  const tokens = await renew(refresh);
  if (tokens === "refused") {
    const response = NextResponse.next();
    response.cookies.delete(REFRESH_COOKIE);
    return response;
  }
  // The backend could not be reached: carry on with what there is and
  // try again on the next request.
  if (!tokens) return NextResponse.next();

  request.cookies.set(ACCESS_COOKIE, tokens.accessToken);
  request.cookies.set(REFRESH_COOKIE, tokens.refreshToken);
  const response = NextResponse.next({ request: { headers: request.headers } });
  const secure = process.env.NODE_ENV === "production";
  response.cookies.set(ACCESS_COOKIE, tokens.accessToken, cookieOptions(tokens.accessToken, secure));
  response.cookies.set(REFRESH_COOKIE, tokens.refreshToken, cookieOptions(tokens.refreshToken, secure));
  return response;
}

async function renew(refreshToken: string): Promise<{ accessToken: string; refreshToken: string } | "refused" | null> {
  try {
    const res = await fetch(`${backendUrl()}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 400 || res.status === 401) return "refused";
    if (!res.ok) return null;
    const body = (await res.json()) as { accessToken?: unknown; refreshToken?: unknown };
    if (typeof body.accessToken !== "string" || typeof body.refreshToken !== "string") return null;
    return { accessToken: body.accessToken, refreshToken: body.refreshToken };
  } catch {
    return null;
  }
}

export const config = {
  // Pages and server actions; not the static files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
