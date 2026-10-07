import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const incoming = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock("next/headers", () => ({ headers: async () => incoming.headers }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("@/lib/session", () => ({ setSessionCookies: vi.fn(async () => undefined) }));

import { loginAction, requestLoginChallenge } from "./actions";

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let sent: Sent[];
let reply: { status: number; body: unknown };

beforeEach(() => {
  sent = [];
  reply = { status: 200, body: {} };
  // Behind nginx, as installer/assets/nginx-panel.conf.template sets it up.
  incoming.headers = new Headers({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.7" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

const solution = { id: "i", challenge: "c", difficulty: 12, expiresAt: 1, signature: "s", nonce: "42" };

describe("the password step", () => {
  it("tells the backend which browser is signing in, so one stranger's failures are not every admin's", async () => {
    reply = { status: 401, body: { message: "Invalid email or password" } };
    await loginAction({}, form({ email: "ops@example.com", password: "wrong-password" }));
    expect(sent[0].url).toMatch(/\/auth\/login$/);
    expect(sent[0].headers["X-Forwarded-For"]).toBe("203.0.113.7");
  });

  it("sends nothing it cannot vouch for", async () => {
    incoming.headers = new Headers({ "x-real-ip": "198.51.100.1", "x-forwarded-for": "203.0.113.7" });
    reply = { status: 401, body: {} };
    await loginAction({}, form({ email: "ops@example.com", password: "wrong-password" }));
    expect(sent[0].headers["X-Forwarded-For"]).toBeUndefined();
  });

  it("passes the browser's solved challenge on to the backend", async () => {
    reply = { status: 401, body: {} };
    await loginAction(
      {},
      form({ email: "ops@example.com", password: "pw-123456", challenge: JSON.stringify(solution) }),
    );
    expect(sent[0].body).toEqual({ email: "ops@example.com", password: "pw-123456", challenge: solution });
  });

  it("does not call a demand for proof of work a wrong password", async () => {
    reply = {
      status: 400,
      body: { message: "Too many recent sign-in attempts. Please sign in at neoxify.net, or wait 30 minutes and try again." },
    };
    const state = await loginAction({}, form({ email: "ops@example.com", password: "right-password" }));
    expect(state.error).not.toMatch(/invalid email or password/i);
    expect(state.error).not.toMatch(/neoxify\.net/);
    expect(state.error).toMatch(/too many recent failed sign-ins/i);
  });

  it("does not call the per-address limit a wrong password", async () => {
    reply = { status: 429, body: { message: "ThrottlerException: Too Many Requests" } };
    const state = await loginAction({}, form({ email: "ops@example.com", password: "right-password" }));
    expect(state.error).not.toMatch(/invalid email or password/i);
    expect(state.error).toMatch(/wait a minute/i);
    expect(state.error).toMatch(/from your address/);
  });

  // With no address it can vouch for, the panel sends none and the backend
  // counts the panel's own: one bucket for every sign-in, anyone's
  // failures included. "From your address" would be untrue.
  it("does not blame the operator's address for a limit every sign-in shares", async () => {
    incoming.headers = new Headers();
    reply = { status: 429, body: { message: "ThrottlerException: Too Many Requests" } };
    const limited = await loginAction({}, form({ email: "ops@example.com", password: "right-password" }));
    expect(sent[0].headers["X-Forwarded-For"]).toBeUndefined();
    expect(limited.error).not.toMatch(/your address/);
    expect(limited.error).toMatch(/through this panel, from anyone/);

    reply = {
      status: 400,
      body: { message: "Too many recent sign-in attempts. Please sign in at neoxify.net, or wait 30 minutes and try again." },
    };
    const challenged = await loginAction({}, form({ email: "ops@example.com", password: "right-password" }));
    expect(challenged.error).not.toMatch(/your address/);
    expect(challenged.error).toMatch(/for this account or through this panel/);
  });

  it("passes on what was wrong with the security check", async () => {
    reply = { status: 400, body: { message: "This security check is out of date. Please try again." } };
    const state = await loginAction({}, form({ email: "ops@example.com", password: "right-password" }));
    expect(state.error).toBe("This security check is out of date. Please try again.");
  });

  it("still says the credentials are wrong when they are", async () => {
    reply = { status: 401, body: { message: "Invalid email or password" } };
    expect((await loginAction({}, form({ email: "a@b.co", password: "wrong-pass" }))).error).toBe(
      "Invalid email or password.",
    );
    reply = { status: 400, body: { message: ["password must be longer than or equal to 8 characters"] } };
    expect((await loginAction({}, form({ email: "a@b.co", password: "short" }))).error).toBe(
      "Invalid email or password.",
    );
  });

  it("moves to the code step when the account has MFA", async () => {
    reply = { status: 200, body: { mfaRequired: true, mfaToken: "mfa-token" } };
    expect(await loginAction({}, form({ email: "a@b.co", password: "right-password" }))).toEqual({
      mfaToken: "mfa-token",
    });
  });

  it("signs in", async () => {
    reply = { status: 200, body: { accessToken: "a", refreshToken: "r" } };
    await expect(loginAction({}, form({ email: "a@b.co", password: "right-password" }))).rejects.toThrow(
      "redirect:/overview",
    );
  });
});

describe("the code step", () => {
  const code = (c = "123456") => form({ mfaToken: "mfa-token", code: c });

  it("is counted against the browser too", async () => {
    reply = { status: 401, body: { message: "Invalid MFA code" } };
    await loginAction({ mfaToken: "mfa-token" }, code());
    expect(sent[0].url).toMatch(/\/auth\/mfa\/verify$/);
    expect(sent[0].headers["X-Forwarded-For"]).toBe("203.0.113.7");
  });

  it("keeps the step for a mistyped code or the per-address limit", async () => {
    reply = { status: 401, body: { message: "Invalid MFA code" } };
    expect(await loginAction({}, code())).toEqual({ error: "Invalid code. Please try again.", mfaToken: "mfa-token" });
    reply = { status: 429, body: {} };
    const limited = await loginAction({}, code());
    expect(limited.mfaToken).toBe("mfa-token");
    expect(limited.error).not.toMatch(/invalid code/i);
    expect(limited.error).toMatch(/from your address/);
  });

  it("does not blame the operator's address for the shared limit either", async () => {
    incoming.headers = new Headers();
    reply = { status: 429, body: {} };
    const limited = await loginAction({}, code());
    expect(limited.mfaToken).toBe("mfa-token");
    expect(limited.error).not.toMatch(/your address/);
    expect(limited.error).toMatch(/through this panel, from anyone/);
  });

  it("goes back to the password step when the step is spent", async () => {
    reply = { status: 401, body: { message: "Too many wrong codes. Try again in 15 minutes." } };
    const locked = await loginAction({}, code());
    expect(locked.mfaToken).toBeUndefined();
    expect(locked.error).toMatch(/15 minutes/);
    reply = { status: 401, body: { message: "Invalid or expired MFA challenge" } };
    const expired = await loginAction({}, code());
    expect(expired.mfaToken).toBeUndefined();
    expect(expired.error).toMatch(/expired/);
  });
});

describe("requestLoginChallenge", () => {
  it("asks for an admin challenge priced for this account and this browser", async () => {
    reply = { status: 201, body: { id: "i", challenge: "c", difficulty: 12, expiresAt: 1, signature: "s" } };
    const challenge = await requestLoginChallenge("ops@example.com");
    expect(challenge?.difficulty).toBe(12);
    expect(sent[0].url).toMatch(/\/login-challenge$/);
    expect(sent[0].body).toEqual({ scope: "admin", email: "ops@example.com" });
    expect(sent[0].headers["X-Forwarded-For"]).toBe("203.0.113.7");
  });

  it("returns nothing when the backend will not issue one", async () => {
    reply = { status: 429, body: {} };
    expect(await requestLoginChallenge("ops@example.com")).toBeUndefined();
  });
});
