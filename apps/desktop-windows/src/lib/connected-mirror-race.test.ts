import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The order a race actually asks in while a tunnel is up and its server
 * is reached around it -- not only the order `apiEndpoints` hands it.
 *
 * Driven through the real api.ts and endpoint-demotion.ts against a
 * network stood in for per address, with a fake clock, as
 * staged-race.test.ts is. The case is the one the order exists for: on a
 * filtered line, before the connect, the API names and the other mirrors
 * timed out and were demoted here, and only the connected node's own
 * mirror answered, so it is the address remembered. `apiEndpoints` puts
 * it last once the tunnel is up; the race then re-sorted by demotion and
 * put it first again, alone, for its whole head start -- a TLS handshake
 * with the mirror's name, around the tunnel. Addresses are stand-ins. */

const A = "https://a.example";
const B = "https://b.example";
const C = "https://c.example";
/** The connected node's own mirror. */
const M = "https://m.example:2053/api";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));
vi.mock("./api-endpoints", () => ({
  // As `apiEndpoints` builds it with the tunnel up: the connected
  // server's mirror last, though it was the last to answer.
  apiEndpoints: () => Promise.resolve([A, B, C, M]),
  rememberEndpoint: () => Promise.resolve(),
  rememberedEndpoint: () => Promise.resolve(M),
  forgetEndpoint: () => Promise.resolve(),
}));
vi.mock("./endpoint-bundle-store", async (importOriginal) => ({
  isKnownBlockPage: (await importOriginal<typeof import("./endpoint-bundle-store")>()).isKnownBlockPage,
  maybeRefreshBundle: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: () => Promise.reject(new Error("could not resolve")),
}));

const { publicRequest, resetRaceWinnerForTests, LEAD_MS } = await import("./api");
const { demoteEndpoint, resetDemotionsForTests } = await import("./endpoint-demotion");
const { setConnectedMirrors, setConfinedAround } = await import("./connected-mirrors");

/** Every origin a request was sent to, in order. */
let sent: string[];
/** The origins that answer, and after how long. Everything else is
 * blackholed. */
let answering: Map<string, number>;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.useFakeTimers();
  resetRaceWinnerForTests();
  resetDemotionsForTests();
  setConnectedMirrors([]);
  setConfinedAround(false);
  sent = [];
  answering = new Map();
  tauriFetch.mockImplementation((url: string, init?: RequestInit) => {
    const base = [A, B, C, M].find((candidate) => url.startsWith(candidate)) ?? url;
    sent.push(base);
    return new Promise((resolve, reject) => {
      const signal = init?.signal;
      const after = answering.get(base);
      const timer = after === undefined ? undefined : setTimeout(() => resolve(json([])), after);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("Request cancelled"));
      });
    });
  });
});

afterEach(() => {
  vi.useRealTimers();
  tauriFetch.mockReset();
});

async function read() {
  const startedAt = Date.now();
  let ms = 0;
  const pending = publicRequest("/customer/routes").then((result) => {
    ms = Date.now() - startedAt;
    return result;
  });
  await vi.runAllTimersAsync();
  return { result: await pending, ms };
}

describe("a race while the connected server is reached around the tunnel", () => {
  it("asks the connected server's mirror after every other address, demoted ones included", async () => {
    for (const base of [A, B, C]) demoteEndpoint(base);
    setConnectedMirrors([M]);
    // Through the tunnel the demoted API name answers after all.
    answering.set(A, 300);
    answering.set(M, 50);

    const { result, ms } = await read();

    expect(result.ok).toBe(true);
    expect(sent[0]).toBe(A);
    expect(sent).not.toContain(M);
    expect(ms).toBe(300);
  });

  it("still asks it, last, when nothing else answers", async () => {
    for (const base of [A, B, C]) demoteEndpoint(base);
    setConnectedMirrors([M]);
    answering.set(M, 50);

    const { result, ms } = await read();

    expect(result.ok).toBe(true);
    expect(sent).toEqual([A, B, C, M]);
    expect(ms).toBe(2 * LEAD_MS + 50);
  });

  /** A write goes first to the address the backend last answered from,
   * without a race. Before the connect that was the node's mirror, and the
   * writes that follow a connect -- the slot moved to the route it landed
   * on, the attempt reported -- went straight to it, around the tunnel. */
  it("does not send a write straight to it for having answered before the connect", async () => {
    answering.set(M, 50);
    expect((await read()).result.ok).toBe(true);

    setConnectedMirrors([M]);
    answering.set(A, 300);
    sent = [];
    const startedAt = Date.now();
    const pending = publicRequest("/client-attempts", { method: "POST", body: "{}" });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.ok).toBe(true);
    expect(sent[0]).toBe(A);
    expect(sent).not.toContain(M);
    expect(Date.now() - startedAt).toBeGreaterThan(0);
  });

  /** Confined (`ipv4Confined: true`): the connected server's mirror is
   * refused on this PC, so a race never asks it while anything else is
   * left -- not even last, when nothing else answers, where the test above
   * asks it. (Here the stand-in network still answers from it; on the PC
   * the request would fail at once with 10013.) */
  it("does not ask it at all while the session is confined", async () => {
    for (const base of [A, B, C]) demoteEndpoint(base);
    setConnectedMirrors([M]);
    setConfinedAround(true);
    answering.set(M, 50);

    await read();

    expect(sent).toEqual([A, B, C]);
  });

  it("leaves the order alone with no tunnel server", async () => {
    for (const base of [A, B, C]) demoteEndpoint(base);
    answering.set(M, 50);

    const { result, sent: asked } = { ...(await read()), sent };

    expect(result.ok).toBe(true);
    expect(asked).toEqual([M]);
  });
});
