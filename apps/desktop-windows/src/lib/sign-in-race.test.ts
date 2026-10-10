import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./api";

/** Where a sign-in goes, and how long it may take, on a filtered network.
 *
 * Driven through the real api.ts, pow.ts and auth.ts, with the network
 * stood in for per address and per path, and the clock faked so that a
 * blackholed address costs exactly what its timeout says.
 *
 * The "before" figures in the comments below were measured by running
 * these same scenarios, on these same four addresses, against the code
 * as it was: the challenge and the sign-in were two walks over the list,
 * eight seconds for each blocked address in each. With the real list of
 * eleven or more addresses every one of them is longer.
 */

const A = "https://a.example";
const B = "https://b.example";
const C = "https://c.example";
const D = "https://d.example";
const ENDPOINTS = [A, B, C, D];

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));

const { remembered } = vi.hoisted(() => ({ remembered: [] as string[] }));
vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve([...ENDPOINTS]),
  rememberEndpoint: (base: string) => {
    remembered.push(base);
    return Promise.resolve();
  },
}));
vi.mock("./endpoint-bundle-store", () => ({ maybeRefreshBundle: () => Promise.resolve() }));
vi.mock("./session", () => ({
  getTokens: async () => null,
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
}));
const reportAttempt = vi.fn();
vi.mock("./attempts", async (original) => {
  const real = await original<typeof import("./attempts")>();
  return { ...real, reportAttempt: (r: unknown) => reportAttempt(r) };
});
vi.mock("./control-plane-probe", () => ({ probeAddendum: async () => undefined }));
vi.mock("./session-end", () => ({ endCustomerSession: vi.fn() }));
vi.mock("./customer", () => ({ clearGamingProfileCache: vi.fn() }));
vi.mock("./i18n", () => ({ currentLanguage: () => "en" }));
vi.mock("./social-auth", () => ({ startSocialSignIn: vi.fn() }));

const { login, register } = await import("./auth");

const UNREACHABLE = "Could not reach Neoxify. Check your internet connection.";
const STOPPED = "Neoxify answered but then stopped responding. Please try again.";

/** How one address treats one request: answers after a delay, never
 * answers (blackholed), or fails at once (reset). */
type Behaviour = { after: number; reply: () => Response } | "hang" | "reset";
type Path = "/login-challenge" | "/customer-auth/login" | "/customer-auth/register";
let network: Record<string, Partial<Record<Path, Behaviour>>>;

/** Every request that left the device, in order. */
let sent: { origin: string; path: string; body: unknown }[];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const page = (status: number) =>
  new Response("<html><body>Not Found</body></html>", { status, headers: { "content-type": "text/html" } });

const challenge = () =>
  json({ id: "c1", challenge: "abc", difficulty: 1, expiresAt: Date.now() + 120_000, signature: "sig" }, 201);
const tokens = () => json({ accessToken: "access", refreshToken: "refresh" });
const throttled = () => json({ statusCode: 429, message: "ThrottlerException: Too Many Requests" }, 429);

const answers = (after: number, reply: () => Response): Behaviour => ({ after, reply });

function respond(behaviour: Behaviour, signal?: AbortSignal | null): Promise<Response> {
  if (behaviour === "reset") return Promise.reject(new Error("error sending request for url"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("Request cancelled"));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort);
    if (behaviour === "hang") return;
    setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(behaviour.reply());
    }, behaviour.after);
  });
}

/** A sign-in, run to the end on the fake clock: its result, and when it
 * arrived. */
async function run(attempt: () => Promise<ApiResult<unknown>>) {
  const started = Date.now();
  let doneAt: number | null = null;
  const pending = attempt().then((result) => {
    doneAt = Date.now() - started;
    return result;
  });
  await vi.runAllTimersAsync();
  const result = await pending;
  return { result, ms: doneAt as unknown as number };
}

const sentTo = (path: Path) => sent.filter((s) => s.path === path).map((s) => s.origin);

beforeEach(() => {
  vi.useFakeTimers();
  // The proof of work, made instant: an all-zero digest satisfies any
  // difficulty at the first nonce. The solver itself is pow's own.
  vi.spyOn(crypto.subtle, "digest").mockResolvedValue(new ArrayBuffer(32));
  network = {};
  sent = [];
  remembered.length = 0;
  reportAttempt.mockReset();
  tauriFetch.mockImplementation((url: string, init?: RequestInit) => {
    const { origin, pathname } = new URL(url);
    sent.push({ origin, path: pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return respond(network[origin]?.[pathname as Path] ?? "hang", init?.signal);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  tauriFetch.mockReset();
});

describe("when nothing answers", () => {
  /** Before: 64 seconds, the challenge walk and then the sign-in walk,
   * eight seconds per address in each. */
  it("says so once the challenge race is over, without sending the sign-in at all", async () => {
    const { result, ms } = await run(() => login("someone@example.com", "pw"));

    expect(result).toEqual({ ok: false, error: UNREACHABLE, noResponse: true });
    expect(sentTo("/customer-auth/login")).toEqual([]);
    // The lead's twenty seconds, after its head start the others' twenty.
    expect(ms).toBe(21_500);
  });

  /** Before: 32 seconds, because the sign-in was walked anyway, over
   * addresses that had just refused the challenge. */
  it("fails at once where every address refuses straight away", async () => {
    for (const origin of ENDPOINTS) network[origin] = { "/login-challenge": "reset" };
    const { result, ms } = await run(() => login("someone@example.com", "pw"));

    expect(result).toMatchObject({ ok: false, error: UNREACHABLE, noResponse: true });
    expect(sentTo("/customer-auth/login")).toEqual([]);
    expect(ms).toBe(0);
  });

  /** The report is what an operator reads. Before, it named only the
   * sign-in's walk; the challenge was never traced at all. */
  it("reports the race it ran as an unreachable control plane", async () => {
    await run(() => login("someone@example.com", "pw"));

    await vi.waitFor(() => expect(reportAttempt).toHaveBeenCalledTimes(1));
    expect(reportAttempt.mock.calls[0][0]).toMatchObject({
      kind: "SIGN_IN",
      outcome: "CONTROL_PLANE_UNREACHABLE",
      apiEndpoint:
        "challenge: a.example=timeout@20000 b.example=timeout@20000 c.example=timeout@20000 d.example=timeout@20000",
    });
  });
});

describe("where the sign-in is sent", () => {
  /** Before: 40.6 seconds with only the last address alive, because both
   * walks waited out every blackholed one. */
  it("goes straight to the address that handed out the challenge", async () => {
    network[A] = { "/login-challenge": "hang", "/customer-auth/login": "hang" };
    network[B] = { "/login-challenge": "hang" };
    network[C] = { "/login-challenge": "reset" };
    network[D] = { "/login-challenge": answers(300, challenge), "/customer-auth/login": answers(300, tokens) };

    const { result, ms } = await run(() => login("someone@example.com", "pw"));

    expect(result.ok).toBe(true);
    expect(sentTo("/customer-auth/login")).toEqual([D]);
    // With the challenge it was given, solved.
    expect(sent.find((s) => s.path === "/customer-auth/login")?.body).toMatchObject({
      challenge: { id: "c1", nonce: "0" },
    });
    expect(ms).toBe(1_500 + 300 + 300);
    expect(remembered).toContain(D);
  });

  /** The usual case, and the reason the race is staggered: the address
   * that answered last time answers again, and no other mirror is asked
   * for a challenge. The challenge is throttled per address, and behind
   * a mirror that address is shared by every customer using it. */
  it("asks only the remembered address while it answers inside its head start", async () => {
    for (const origin of ENDPOINTS) {
      network[origin] = { "/login-challenge": answers(200, challenge), "/customer-auth/login": answers(200, tokens) };
    }

    const { result } = await run(() => login("someone@example.com", "pw"));

    expect(result.ok).toBe(true);
    expect(sentTo("/login-challenge")).toEqual([A]);
    expect(sentTo("/customer-auth/login")).toEqual([A]);
  });

  /** A node's fallback site without the API, or the CDN's bot check,
   * answers in a few milliseconds. It is not the backend. Before, the
   * sign-in went to it first and stopped there with "Request failed
   * (404)". */
  it("does not let a page from in front of the backend win", async () => {
    network[A] = { "/login-challenge": answers(50, () => page(404)), "/customer-auth/login": answers(50, () => page(404)) };
    network[B] = { "/login-challenge": answers(400, challenge), "/customer-auth/login": answers(400, tokens) };

    const { result } = await run(() => login("someone@example.com", "pw"));

    expect(result.ok).toBe(true);
    expect(sentTo("/customer-auth/login")).toEqual([B]);
    expect(remembered).not.toContain(A);
  });

  /** One mirror over its throttle says nothing about the next: the limit
   * is counted per address, and a mirror's address is the node's. Before,
   * the sign-in went to the throttled one, without a challenge, and was
   * refused. */
  it("keeps racing past a throttled address for one that hands out a challenge", async () => {
    network[A] = { "/login-challenge": answers(50, throttled), "/customer-auth/login": answers(50, throttled) };
    network[B] = { "/login-challenge": answers(500, challenge), "/customer-auth/login": answers(300, tokens) };

    const { result } = await run(() => login("someone@example.com", "pw"));

    expect(result.ok).toBe(true);
    expect(sentTo("/customer-auth/login")).toEqual([B]);
    expect(sent.find((s) => s.path === "/customer-auth/login")?.body).toHaveProperty("challenge");
  });

  /** Then the other addresses that answered -- and only those. One that
   * gave nothing in the race is not worth another eight seconds. */
  it("falls back to the other addresses that answered, never to the silent ones", async () => {
    network[A] = { "/login-challenge": answers(50, throttled), "/customer-auth/login": answers(100, tokens) };
    network[B] = { "/login-challenge": answers(300, challenge), "/customer-auth/login": "reset" };
    network[C] = { "/customer-auth/login": answers(100, tokens) };

    const { result } = await run(() => login("someone@example.com", "pw"));

    expect(result.ok).toBe(true);
    expect(sentTo("/customer-auth/login")).toEqual([B, A]);
  });

  it("does the same for a sign-up", async () => {
    network[C] = { "/login-challenge": "reset" };
    network[D] = {
      "/login-challenge": answers(300, challenge),
      "/customer-auth/register": answers(300, () => json({ requiresVerification: true, email: "x" })),
    };

    const { result, ms } = await run(() => register("someone@example.com", "password1"));

    expect(result.ok).toBe(true);
    expect(sentTo("/customer-auth/register")).toEqual([D]);
    expect(ms).toBe(1_500 + 300 + 300);
  });
});

describe("a slow route", () => {
  /** The CDN answering after nine to twenty seconds while every mirror
   * is blocked: a shape that fits the testers' reports, modelled here,
   * not observed on their networks. Before, the answer was thrown away at
   * eight seconds, twice, and after 40 seconds the screen said Neoxify
   * could not be reached. */
  it("signs in through a CDN that takes fifteen seconds for each answer", async () => {
    network[A] = { "/login-challenge": answers(15_000, challenge), "/customer-auth/login": answers(15_000, tokens) };
    for (const origin of [B, C, D]) network[origin] = { "/login-challenge": "reset" };

    const { result, ms } = await run(() => login("someone@example.com", "pw"));

    expect(result.ok).toBe(true);
    expect(sentTo("/customer-auth/login")).toEqual([A]);
    expect(ms).toBe(30_000);
  });
});

describe("an answer that stops", () => {
  /** Neoxify was reached seconds earlier, so "could not reach Neoxify --
   * check your internet connection" would send the customer to look at a
   * connection that was working. Before: 32.1 seconds, then that
   * sentence. */
  it("says it stopped responding, after one timeout at the address that answered", async () => {
    network[A] = { "/login-challenge": answers(100, challenge), "/customer-auth/login": "hang" };

    const { result, ms } = await run(() => login("someone@example.com", "pw"));

    expect(result).toEqual({ ok: false, error: STOPPED, noResponse: true });
    expect(sentTo("/customer-auth/login")).toEqual([A]);
    expect(ms).toBe(100 + 8_000);

    // Still an unreachable control plane to whoever reads the report.
    await vi.waitFor(() => expect(reportAttempt).toHaveBeenCalledTimes(1));
    expect(reportAttempt.mock.calls[0][0]).toMatchObject({
      outcome: "CONTROL_PLANE_UNREACHABLE",
      apiEndpoint: "challenge: a.example=h201@100; req: a.example=timeout@8000",
    });
  });

  /** There was no limit on the whole: the button sat on "Signing in..."
   * for as long as the walks took, 50 seconds here. */
  it("ends the whole sign-in by its deadline", async () => {
    network[A] = { "/login-challenge": answers(19_000, challenge), "/customer-auth/login": "hang" };
    network[C] = { "/login-challenge": answers(2_000, throttled), "/customer-auth/login": "hang" };
    network[D] = { "/login-challenge": answers(2_000, throttled), "/customer-auth/login": "hang" };

    const { result, ms } = await run(() => login("someone@example.com", "pw"));

    expect(result).toMatchObject({ ok: false, error: STOPPED, noResponse: true });
    // The deadline: the head start, two slow answers' worth, and slack.
    expect(ms).toBe(45_000);
    // A got its twenty seconds, C the eight it had left, D never started.
    expect(sentTo("/customer-auth/login")).toEqual([A, C]);

    await vi.waitFor(() => expect(reportAttempt).toHaveBeenCalledTimes(1));
    const trace = String((reportAttempt.mock.calls[0][0] as { apiEndpoint: string }).apiEndpoint);
    // Cut off by the deadline, which is not the network refusing it.
    expect(trace).toContain("req: a.example=timeout@20000 c.example=budget@6000");
  });
});
