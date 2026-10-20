import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "./proxy";

const NOW_S = Math.floor(Date.now() / 1000);
const token = (expIn: number, tag: string) =>
  `h.${Buffer.from(JSON.stringify({ sub: "a", tag, exp: NOW_S + expIn })).toString("base64url")}.s`;

function request(cookies: Record<string, string>) {
  return new NextRequest("http://panel.test/overview", {
    headers: {
      cookie: Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    },
  });
}

function backendReplies(status: number, body: unknown) {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () => new Response(JSON.stringify(body), { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("proxy", () => {
  it("leaves a fresh session alone and asks nobody", async () => {
    const fetchMock = backendReplies(200, {});
    await proxy(request({ neoxify_access: token(600, "a"), neoxify_refresh: token(3_000, "r") }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renews an expiring session, stores the new pair and hands it to this request", async () => {
    const access = token(900, "new-a");
    const refresh = token(3_600, "new-r");
    const fetchMock = backendReplies(200, { accessToken: access, refreshToken: refresh });
    const response = await proxy(request({ neoxify_access: token(30, "a"), neoxify_refresh: token(3_000, "r") }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/auth\/refresh$/);
    expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: token(3_000, "r") });

    expect(response.cookies.get("neoxify_access")?.value).toBe(access);
    expect(response.cookies.get("neoxify_refresh")?.value).toBe(refresh);
    expect(response.cookies.get("neoxify_refresh")?.maxAge).toBeGreaterThan(3_500);
    // Forwarded to the page being rendered, not only to the browser.
    expect(response.headers.get("x-middleware-request-cookie") ?? "").toContain(access);
  });

  it("drops the refresh cookie once the backend refuses it", async () => {
    backendReplies(401, { message: "Session has expired; sign in again" });
    const response = await proxy(request({ neoxify_refresh: token(3_000, "r") }));
    expect(response.cookies.get("neoxify_refresh")?.value).toBe("");
  });

  it("keeps everything when the backend cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const response = await proxy(request({ neoxify_refresh: token(3_000, "r") }));
    expect(response.cookies.get("neoxify_refresh")).toBeUndefined();
  });
});
