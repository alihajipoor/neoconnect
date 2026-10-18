import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayAnswer } from "./last-resort";

/** Signing in and signing up through the relay of last resort
 * (docs/relay-last-resort.md, R1.2, R3, R4.2): what auth.ts sends there,
 * in what order, and what it does with the answers. Every ordinary route
 * is unreachable here unless a test says otherwise. */

type Reply = { status: number; body?: unknown } | "unreachable";
const replies: Record<string, Reply[]> = {};
const fetched: string[] = [];
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string) => {
    const path = url.replace("https://a.example", "");
    fetched.push(path);
    const reply = replies[path]?.shift() ?? "unreachable";
    if (reply === "unreachable") return Promise.reject(new Error(`error sending request for url (${url})`));
    return Promise.resolve(
      new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      }),
    );
  },
}));
vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve(["https://a.example"]),
  rememberEndpoint: () => Promise.resolve(),
  rememberedEndpoint: () => Promise.resolve(undefined),
  forgetEndpoint: () => Promise.resolve(),
}));
const RELAY = { url: "https://192.0.2.10/api", pins: [`sha256/${btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))}`] };
vi.mock("./endpoint-bundle-store", () => ({
  maybeRefreshBundle: () => Promise.resolve(),
  lastResortEntries: () => Promise.resolve([RELAY]),
}));
vi.mock("./network-identity", () => ({
  networkKeyFromAsn: () => "asn:58224",
  stampedCountry: () => "IR",
  currentAttestation: () => null,
}));
let stored: { accessToken: string; refreshToken: string } | null = null;
vi.mock("./session", () => ({
  getTokens: async () => stored,
  setTokens: async (t: { accessToken: string; refreshToken: string }) => {
    stored = t;
  },
  clearTokens: async () => {
    stored = null;
  },
}));
vi.mock("./attempts", async (original) => {
  const real = await original<typeof import("./attempts")>();
  return { ...real, reportAttempt: vi.fn() };
});
vi.mock("./control-plane-probe", () => ({ probeAddendum: async () => undefined }));
vi.mock("./session-end", () => ({ endCustomerSession: vi.fn() }));
vi.mock("./customer", () => ({ clearGamingProfileCache: vi.fn() }));
vi.mock("./i18n", () => ({ currentLanguage: () => "fa" }));
vi.mock("./social-auth", () => ({ startSocialSignIn: vi.fn() }));

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const { login, register, relayRegister, resetPasswordByRecoveryCode, setPassword } = await import("./auth");
const { resetRaceWinnerForTests } = await import("./api");
const lr = await import("./last-resort");

type Relayed = { method: string; path: string; headers: Record<string, string>; body: string | null };
let relayed: Relayed[] = [];
let relayReplies: (RelayAnswer | string)[] = [];
let tunnelUp: boolean | null = false;

const json = (status: number, body: unknown): RelayAnswer => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
/** A challenge any nonce solves, so the tests do not spend time on work. */
const CHALLENGE = { id: "c", challenge: "x", difficulty: 0, expiresAt: Date.now() + 60_000, signature: "s" };
const TOKENS = { accessToken: "a1", refreshToken: "r1" };

beforeEach(() => {
  resetRaceWinnerForTests();
  for (const key of Object.keys(replies)) delete replies[key];
  fetched.length = 0;
  store.clear();
  stored = null;
  relayed = [];
  relayReplies = [];
  tunnelUp = false;
  lr.resetLastResortForTests({
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

const body = (r: Relayed) => JSON.parse(r.body ?? "null") as Record<string, unknown>;

describe("signing in", () => {
  it("goes through the relay only after every ordinary route failed, challenge first", async () => {
    relayReplies = [json(200, CHALLENGE), json(200, TOKENS)];
    const result = await login("a@example.com", "password1");
    expect(result).toEqual({ ok: true, data: TOKENS });
    expect(relayed.map((r) => r.path)).toEqual(["/login-challenge", "/customer-auth/login"]);
    expect(body(relayed[0])).toEqual({ scope: "customer", email: "a@example.com" });
    expect(body(relayed[1])).toMatchObject({ email: "a@example.com", password: "password1", challenge: { nonce: "0" } });
    expect(stored).toEqual(TOKENS);
  });

  it("does not touch the relay when an ordinary route answers", async () => {
    replies["/login-challenge"] = [{ status: 200, body: CHALLENGE }];
    replies["/customer-auth/login"] = [{ status: 401, body: { message: "Invalid email or password" } }];
    relayReplies = [json(200, CHALLENGE), json(200, TOKENS)];
    const result = await login("a@example.com", "wrong");
    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(relayed).toEqual([]);
  });

  it("pays a relay sign-up's proof of work when an unverified account is converted (R4.2)", async () => {
    relayReplies = [
      json(200, CHALLENGE),
      json(400, { statusCode: 400, code: "CHALLENGE_REQUIRED", scope: "relay-signup", message: "A security check is required." }),
      json(200, { ...CHALLENGE, id: "c2" }),
      json(200, TOKENS),
    ];
    const result = await login("a@example.com", "password1");
    expect(result).toEqual({ ok: true, data: TOKENS });
    expect(relayed.map((r) => r.path)).toEqual([
      "/login-challenge",
      "/customer-auth/login",
      "/login-challenge",
      "/customer-auth/login",
    ]);
    expect(body(relayed[2])).toEqual({ scope: "relay-signup" });
    expect(relayed[2].headers["x-neoxify-install-id"]).toBe(lr.relayInstallId());
    expect(body(relayed[3]).challenge).toMatchObject({ id: "c2" });
  });

  it("keeps the backend's reason when the relay refuses, worded by its code", async () => {
    relayReplies = [json(200, CHALLENGE), json(403, { statusCode: 403, code: "RELAY_REGION", message: "..." })];
    const result = await login("a@example.com", "password1");
    expect(result).toMatchObject({ ok: false, status: 403, code: "RELAY_REGION" });
    // And the relay is off on this network now.
    expect(await lr.relayRequest({ method: "GET", path: "/health" }, "foreground")).toEqual({
      kind: "skipped",
      reason: "off",
    });
  });

  it("says the backup server was tried when it did not answer", async () => {
    const result = await login("a@example.com", "password1");
    expect(result).toMatchObject({ ok: false, noResponse: true, relayTried: true });
  });

  it("tells the customer to disconnect when a tunnel holds the gate", async () => {
    tunnelUp = true;
    const result = await login("a@example.com", "password1");
    expect(result).toMatchObject({ ok: false, code: "RELAY_DISCONNECT" });
    expect(relayed).toEqual([]);
  });

  it("does not use the relay when the customer declined it, and says nothing of it", async () => {
    lr.setBackupRouteOn(false);
    const result = await login("a@example.com", "password1");
    expect(result).toMatchObject({ ok: false, noResponse: true });
    expect(result).not.toHaveProperty("relayTried");
    expect(relayed).toEqual([]);
  });
});

describe("signing up", () => {
  it("offers the relay's sign-up after every ordinary route failed, without sending it anything", async () => {
    const result = await register("a@example.com", "password1");
    expect(result).toMatchObject({ ok: false, noResponse: true, relaySignup: true });
    expect(relayed).toEqual([]);
  });

  it("does not offer it after an answer -- the address is taken, the throttle", async () => {
    replies["/login-challenge"] = [{ status: 200, body: CHALLENGE }];
    replies["/customer-auth/register"] = [{ status: 409, body: { message: "A customer with this email already exists" } }];
    const result = await register("a@example.com", "password1");
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result).not.toHaveProperty("relaySignup");
  });

  it("signs up through the relay alone, stores the session and hands back the recovery code once", async () => {
    relayReplies = [
      json(200, CHALLENGE),
      json(200, { ...TOKENS, recoveryCode: "ABCD-EFGH-JKLM-NPQR", relayUnverified: true }),
    ];
    const result = await relayRegister("a@example.com", "a@example.com", "password1");
    expect(result).toEqual({ ok: true, data: { recoveryCode: "ABCD-EFGH-JKLM-NPQR" } });
    expect(stored).toEqual(TOKENS);
    expect(fetched).toEqual([]);
    expect(relayed.map((r) => r.path)).toEqual(["/login-challenge", "/customer-auth/relay-register"]);
    expect(body(relayed[0])).toEqual({ scope: "relay-signup" });
    expect(body(relayed[1])).toMatchObject({
      email: "a@example.com",
      emailConfirm: "a@example.com",
      password: "password1",
      locale: "fa",
      challenge: { id: "c" },
    });
    expect(relayed[1].headers["x-neoxify-install-id"]).toBe(lr.relayInstallId());
  });

  it("is not available when the relay cannot be used, and says so", async () => {
    lr.setBackupRouteOn(false);
    const result = await relayRegister("a@example.com", "a@example.com", "password1");
    expect(result).toMatchObject({ ok: false, code: "RELAY_UNAVAILABLE" });
    expect(relayed).toEqual([]);
  });

  it("passes on the backend's refusal", async () => {
    relayReplies = [json(200, CHALLENGE), json(400, { statusCode: 400, code: "DISPOSABLE_EMAIL", message: "..." })];
    const result = await relayRegister("a@mailinator.com", "a@mailinator.com", "password1");
    expect(result).toMatchObject({ ok: false, code: "DISPOSABLE_EMAIL" });
    expect(stored).toBeNull();
  });
});

describe("the ways back in", () => {
  it("resets by recovery code through the relay when nothing else answers", async () => {
    relayReplies = [json(200, { recoveryCode: "NEW0-CODE-NEW0-CODE" })];
    const result = await resetPasswordByRecoveryCode("a@example.com", "ABCD EFGH JKLM NPQR", "password2");
    expect(result).toEqual({ ok: true, data: { recoveryCode: "NEW0-CODE-NEW0-CODE" } });
    expect(relayed.map((r) => r.path)).toEqual(["/customer-auth/reset-password-recovery"]);
  });

  it("sets a password for a social account, with the session's token", async () => {
    stored = TOKENS;
    relayReplies = [{ status: 204, contentType: "", body: "" }];
    expect(await setPassword("password3")).toEqual({ ok: true, data: undefined });
    expect(relayed[0].headers.authorization).toBe("Bearer a1");
  });
});
