import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayAnswer } from "./last-resort";

/** Where api.ts hands a request to the relay of last resort, and where it
 * must not (docs/relay-last-resort.md, R1.1, R1.2, R1.7). The relay's own
 * policy is last-resort.test.ts's; here it is real, with a fake command
 * underneath. */

type Reply = { status: number; body?: unknown } | "unreachable" | "scope";
const replies: Record<string, Reply[]> = {};
const fetched: string[] = [];

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string) => {
    const path = url.replace("https://a.example", "");
    fetched.push(path);
    const reply = replies[path]?.shift() ?? "unreachable";
    if (reply === "unreachable") return Promise.reject(new Error(`error sending request for url (${url})`));
    if (reply === "scope") return Promise.reject(new Error(`url not allowed on the configured scope: ${url}`));
    return Promise.resolve(
      new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      }),
    );
  },
}));
const remembered: string[] = [];
vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve(["https://a.example"]),
  rememberEndpoint: (url: string) => {
    remembered.push(url);
    return Promise.resolve();
  },
  rememberedEndpoint: () => Promise.resolve(undefined),
  forgetEndpoint: () => Promise.resolve(),
}));
const RELAY = { url: "https://192.0.2.10/api", pins: [`sha256/${btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))}`] };
vi.mock("./endpoint-bundle-store", () => ({
  maybeRefreshBundle: () => Promise.resolve(),
  lastResortEntries: () => Promise.resolve([RELAY]),
  maybeRefreshBundleThroughRelay: () => Promise.resolve(),
}));
vi.mock("./network-identity", () => ({
  networkKeyFromAsn: () => "asn:58224",
  stampedCountry: () => "IR",
}));

let stored: { accessToken: string; refreshToken: string } | null = null;
vi.mock("./session", () => ({
  getTokens: () => Promise.resolve(stored),
  setTokens: (t: { accessToken: string; refreshToken: string }) => {
    stored = t;
    return Promise.resolve();
  },
  clearTokens: () => {
    stored = null;
    return Promise.resolve();
  },
}));

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const { apiRequest, everyRouteFailed, publicRequest, resetRaceWinnerForTests, STOPPED_ANSWERING } = await import("./api");
const lr = await import("./last-resort");
const { onSessionRevoked } = await import("./session-revoked");
const { failureText } = await import("./failure-text");
const { DICTIONARIES } = await import("./i18n");

type Relayed = { method: string; path: string; headers: Record<string, string>; body: string | null; base: string };
let relayed: Relayed[] = [];
let relayReplies: (RelayAnswer | string)[] = [];
let now = 5_000_000;
let tunnelUp: boolean | null = false;
let revoked = 0;
onSessionRevoked(() => {
  revoked += 1;
});

const json = (status: number, body: unknown): RelayAnswer => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

beforeEach(() => {
  resetRaceWinnerForTests();
  for (const key of Object.keys(replies)) delete replies[key];
  fetched.length = 0;
  remembered.length = 0;
  store.clear();
  relayed = [];
  relayReplies = [];
  now = 5_000_000;
  tunnelUp = false;
  revoked = 0;
  stored = { accessToken: "access", refreshToken: "refresh" };
  lr.resetLastResortForTests({
    now: () => now,
    tunnelUp: () => Promise.resolve(tunnelUp),
    transport: async (args) => {
      relayed.push(args as Relayed);
      const reply = relayReplies.shift();
      if (reply === undefined) throw "relay: connect-timeout";
      if (typeof reply === "string") throw reply;
      return reply;
    },
  });
  lr.setBackupRouteOn(true);
});

const ME = { id: "c1", email: "a@example.com" };

describe("a request the ordinary routes answer", () => {
  it("never touches the relay, whatever it opted into", async () => {
    replies["/customer/me"] = [{ status: 200, body: ME }];
    replies["/health"] = [{ status: 200, body: { status: "ok" } }];
    replies["/customer-auth/forgot-password"] = [{ status: 204 }];
    relayReplies = [json(200, ME), json(200, ME)];
    expect(await apiRequest("/customer/me", { relay: "foreground" })).toEqual({ ok: true, data: ME });
    expect(
      await publicRequest("/customer-auth/forgot-password", {
        method: "POST",
        body: "{}",
        relay: "foreground",
      }),
    ).toEqual({ ok: true, data: undefined });
    expect(relayed).toEqual([]);
  });

  it("is not sent to the relay when the backend refused it, or only a page answered", async () => {
    replies["/customer/me"] = [{ status: 500, body: { message: "boom" } }];
    relayReplies = [json(200, ME)];
    const result = await apiRequest("/customer/me", { relay: "foreground" });
    expect(result.ok).toBe(false);
    expect(relayed).toEqual([]);
  });
});

describe("a request every ordinary route failed", () => {
  it("goes through the relay when it opted in, and is answered from there", async () => {
    relayReplies = [json(200, ME)];
    expect(await apiRequest("/customer/me", { relay: "background" })).toEqual({ ok: true, data: ME });
    expect(relayed.map((r) => [r.method, r.path, r.headers.authorization])).toEqual([
      ["GET", "/customer/me", "Bearer access"],
    ]);
    // The relay is never the address to remember.
    expect(remembered).toEqual([]);
  });

  it("never goes through the relay when it did not opt in", async () => {
    relayReplies = [json(200, ME)];
    const result = await apiRequest("/customer/me");
    expect(result).toMatchObject({ ok: false, noResponse: true });
    expect(relayed).toEqual([]);
  });

  it("does not go through the relay after the scope refused it", async () => {
    replies["/customer/me"] = ["scope"];
    relayReplies = [json(200, ME)];
    expect((await apiRequest("/customer/me", { relay: "foreground" })).ok).toBe(false);
    expect(relayed).toEqual([]);
  });

  it("says the backup server was tried only when it was", async () => {
    relayReplies = ["relay: connect-timeout"];
    const tried = await apiRequest("/customer/me", { relay: "foreground" });
    expect(tried).toMatchObject({ ok: false, noResponse: true, relayTried: true });
    store.set("neoxify.relay.switch", "off");
    const declined = await apiRequest("/customer/me", { relay: "foreground" });
    expect(declined).toMatchObject({ ok: false, noResponse: true });
    expect(declined).not.toHaveProperty("relayTried");
    const t = (key: keyof (typeof DICTIONARIES)["en"]) => DICTIONARIES.en[key];
    expect(failureText(tried as never, t)).toBe(DICTIONARIES.en["api.unreachableWithBackup"]);
    expect(failureText(declined as never, t)).toBe(DICTIONARIES.en["api.unreachable"]);
  });

  it("tells a request the customer made to disconnect when a tunnel holds the gate", async () => {
    tunnelUp = true;
    relayReplies = [json(200, ME)];
    const foreground = await apiRequest("/customer/me", { relay: "foreground" });
    expect(foreground).toMatchObject({ ok: false, code: "RELAY_DISCONNECT" });
    const background = await apiRequest("/customer/me", { relay: "background" });
    expect(background).toMatchObject({ ok: false, noResponse: true });
    expect(background).not.toHaveProperty("code");
    expect(relayed).toEqual([]);
    const t = (key: keyof (typeof DICTIONARIES)["en"]) => DICTIONARIES.en[key];
    expect(failureText(foreground as never, t)).toBe(DICTIONARIES.en["relay.disconnect"]);
  });

  it("renews the session through the relay on its 401, and retries once", async () => {
    relayReplies = [
      json(401, { message: "Unauthorized" }),
      json(200, { accessToken: "fresh", refreshToken: "refresh2" }),
      json(200, ME),
    ];
    expect(await apiRequest("/customer/me", { relay: "background" })).toEqual({ ok: true, data: ME });
    expect(relayed.map((r) => r.path)).toEqual(["/customer/me", "/customer-auth/refresh", "/customer/me"]);
    expect(relayed[2].headers.authorization).toBe("Bearer fresh");
    expect(stored).toEqual({ accessToken: "fresh", refreshToken: "refresh2" });
  });

  it("ends the session when the backend refuses the refresh through the relay", async () => {
    relayReplies = [json(401, { message: "Unauthorized" }), json(401, { message: "Refresh token has been revoked" })];
    const result = await apiRequest("/customer/me", { relay: "background" });
    expect(result).toMatchObject({ ok: false, sessionExpired: true });
    expect(stored).toBeNull();
    expect(revoked).toBe(1);
  });

  it("sends each header once, whatever spellings the caller used", async () => {
    relayReplies = [json(200, ME)];
    await apiRequest("/customer/me", {
      headers: { "content-type": "application/json", AUTHORIZATION: "Bearer stale" },
      relay: "background",
    });
    expect(relayed[0].headers).toEqual({ "content-type": "application/json", authorization: "Bearer access" });
  });

  it("keeps the backend's refusal and its code", async () => {
    relayReplies = [json(403, { statusCode: 403, code: "VOUCHER_NOT_ALLOWED", message: "No." })];
    const result = await apiRequest("/customer/vouchers/redeem", {
      method: "POST",
      body: JSON.stringify({ code: "X" }),
      relay: "foreground",
    });
    expect(result).toMatchObject({ ok: false, status: 403, code: "VOUCHER_NOT_ALLOWED" });
  });
});

describe("relay mode", () => {
  it("sends a request straight to the relay, and asks the ordinary routes again after three minutes", async () => {
    relayReplies = [json(200, ME)];
    await apiRequest("/customer/me", { relay: "background" });
    fetched.length = 0;
    relayReplies = [json(200, ME)];
    expect(await apiRequest("/customer/me", { relay: "background" })).toEqual({ ok: true, data: ME });
    expect(fetched).toEqual([]);
    now += 3 * 60_000;
    replies["/customer/me"] = [{ status: 200, body: ME }];
    expect(await apiRequest("/customer/me", { relay: "background" })).toEqual({ ok: true, data: ME });
    expect(fetched).toEqual(["/customer/me"]);
    // That answer was the usual way working again.
    expect(lr.relayModeActive()).toBe(false);
  });

  it("does not send what the relay cannot carry anywhere but the ordinary routes", async () => {
    relayReplies = [json(200, ME)];
    await apiRequest("/customer/me", { relay: "background" });
    fetched.length = 0;
    relayed = [];
    const result = await apiRequest("/customer/billing/payments", {
      method: "POST",
      body: "{}",
      relay: "foreground",
    });
    expect(result.ok).toBe(false);
    expect(relayed).toEqual([]);
    expect(fetched.length).toBeGreaterThan(0);
  });
});

describe("what counts as every route failing (R1.2)", () => {
  type Outcome = Parameters<typeof everyRouteFailed>[1]["entries"][number]["outcome"];
  const trace = (...outcomes: Outcome[]) => ({
    phase: "req" as const,
    entries: outcomes.map((outcome, i) => ({ phase: "req" as const, base: `https://${i}.example`, startedAt: 0, outcome })),
  });
  const unanswered = { ok: false as const, error: "Could not reach Neoxify.", noResponse: true as const };

  it("is every address failing in transport, or a block page", () => {
    expect(everyRouteFailed(unanswered, trace("net", "timeout", "blockpage"))).toBe(true);
    expect(everyRouteFailed(unanswered, trace("timeout", "pending"))).toBe(true);
    expect(everyRouteFailed({ ...unanswered, blockPage: true }, trace())).toBe(true);
  });

  it("is never an answer, a scope or a local refusal, or nothing tried", () => {
    expect(everyRouteFailed(unanswered, trace("net", "scope"))).toBe(false);
    expect(everyRouteFailed(unanswered, trace("timeout", "local"))).toBe(false);
    expect(everyRouteFailed(unanswered, trace("net", "h502"))).toBe(false);
    expect(everyRouteFailed(unanswered, trace("net", "cancel"))).toBe(false);
    expect(everyRouteFailed(unanswered, trace())).toBe(false);
    expect(everyRouteFailed(unanswered, trace("pending"))).toBe(false);
  });

  it("is never a failure that was answered, or one the backend answered moments before", () => {
    expect(everyRouteFailed({ ok: false, error: "Request failed (500)", status: 500 }, trace("net"))).toBe(false);
    expect(everyRouteFailed({ ...unanswered, error: STOPPED_ANSWERING }, trace("net"))).toBe(false);
    expect(everyRouteFailed({ ...unanswered, code: "RELAY_DISCONNECT" }, trace("net"))).toBe(false);
  });
});
