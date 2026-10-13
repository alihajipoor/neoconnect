import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What becomes of the answers a race hears after it has been decided.
 *
 * Under the HTTP plugin a response is parked on the Rust side, with its
 * connection, until its body is read to the end or cancelled. A race stops
 * the requests it no longer wants by aborting them, and the plugin hears
 * that abort on the response's body stream -- which does not exist until
 * the answer does. A request whose answer was already on its way when the
 * abort was sent got its answer anyway, with nothing listening for an abort
 * that had come and gone (a VM trace: `fetch_cancel` at 2.07 s, the 200 at
 * 2.12 s). The race pushed it onto its list of answers and nobody read it
 * or cancelled it, so its connection stayed open on whatever adapter it was
 * made: after a Disconnect, five connections to node mirrors sent
 * keep-alives by the physical adapter through the whole of the next tunnel.
 *
 * Driven through the real api.ts against a network stood in for per
 * address, with a fake clock, and a `fetch` that behaves as the plugin did:
 * an abort that lands after the answer exists releases it; an answer whose
 * request was aborted before it arrived is handed back regardless, its
 * release left to whoever holds it. Every answer here is either read to its
 * end or released, or the test fails. Addresses are stand-ins. */

const A = "https://a.example";
const B = "https://b.example";
const C = "https://c.example";
const D = "https://d.example";

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));
vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve([A, B, C, D]),
  rememberEndpoint: () => Promise.resolve(),
  rememberedEndpoint: () => Promise.resolve(undefined),
  forgetEndpoint: () => Promise.resolve(),
}));
vi.mock("./endpoint-bundle-store", async (importOriginal) => ({
  isKnownBlockPage: (await importOriginal<typeof import("./endpoint-bundle-store")>()).isKnownBlockPage,
  maybeRefreshBundle: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: () => Promise.reject(new Error("could not resolve")),
}));

const { answeringEndpoint, publicRace, publicRequest, resetRaceWinnerForTests, LEAD_MS } = await import("./api");
const { resetDemotionsForTests } = await import("./endpoint-demotion");

/** One answer handed out by the stand-in, and what became of it. */
interface Handed {
  label: string;
  /** Cancelled, or released by an abort heard after it existed. */
  released: boolean;
  /** Read to its end, which releases it on the Rust side by itself. */
  read: boolean;
}
let handed: Handed[];

/** When each address answers, from when it is asked; `late` for an answer
 * already on its way, which arrives even if the request is aborted first. */
type Behaviour = { after: number; late?: boolean };
let network: Record<string, Behaviour>;

function answer(label: string, signal: AbortSignal | null | undefined): Response {
  const record: Handed = { label, released: false, read: false };
  handed.push(record);
  const bytes = new TextEncoder().encode(JSON.stringify({ status: "ok" }));
  // No high-water mark: pulled only when somebody reads, so `read` is a
  // reader and not the stream filling its own queue.
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        // As the plugin does: an abort releases the body -- but only one
        // heard from here on. Registered on a signal that has already
        // fired, this never runs, which is the case under test.
        signal?.addEventListener("abort", () => {
          record.released = true;
          controller.error(new Error("Request cancelled"));
        });
      },
      pull(controller) {
        controller.enqueue(bytes);
        controller.close();
        record.read = true;
      },
      cancel() {
        record.released = true;
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
}

function respond(url: string, signal: AbortSignal | null | undefined): Promise<Response> {
  const base = [A, B, C, D].find((candidate) => url.startsWith(candidate)) ?? url;
  const behaviour = network[base];
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      if (behaviour?.late) return;
      clearTimeout(timer);
      reject(new Error("Request cancelled"));
    };
    if (signal?.aborted && !behaviour?.late) return reject(new Error("Request cancelled"));
    signal?.addEventListener("abort", onAbort);
    const timer =
      behaviour === undefined
        ? undefined
        : setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve(answer(base, signal));
          }, behaviour.after);
  });
}

async function run<T>(request: () => Promise<T>): Promise<T> {
  const pending = request();
  await vi.runAllTimersAsync();
  return await pending;
}

/** The answers left parked: neither read nor released. */
const parked = () => handed.filter((h) => !h.read && !h.released).map((h) => h.label);

beforeEach(() => {
  vi.useFakeTimers();
  resetRaceWinnerForTests();
  resetDemotionsForTests();
  handed = [];
  // The first address is slow, so the rest are asked at `LEAD_MS`; B wins,
  // and C, D and A answer just after it -- each already on its way when the
  // race stopped it.
  network = {
    [A]: { after: LEAD_MS + 80, late: true },
    [B]: { after: 50 },
    [C]: { after: 60, late: true },
    [D]: { after: 70, late: true },
  };
  tauriFetch.mockImplementation((url: string, init?: RequestInit) => respond(url, init?.signal));
});

afterEach(() => {
  vi.useRealTimers();
  tauriFetch.mockReset();
});

describe("an answer that arrives after its race was decided", () => {
  it("is let go of by the health race, which reads no body", async () => {
    const base = await run(() => answeringEndpoint([A, B, C, D]));

    expect(base).toBe(B);
    expect(handed.map((h) => h.label).sort()).toEqual([A, B, C, D]);
    expect(parked()).toEqual([]);
  });

  it("is let go of by a read's race, whose winner is read", async () => {
    const result = await run(() => publicRequest<{ status: string }>("/customer/routes"));

    expect(result).toEqual({ ok: true, data: { status: "ok" } });
    expect(handed.find((h) => h.label === B)?.read).toBe(true);
    expect(parked()).toEqual([]);
  });

  it("is let go of by the sign-in challenge's race", async () => {
    const raced = await run(() => publicRace<{ status: string }>("/customer-auth/challenge", { method: "GET" }));

    expect(raced.result).toEqual({ ok: true, data: { status: "ok" } });
    expect(parked()).toEqual([]);
  });

  /** Each race's own: thirty-two at once, so that no answer is let go of
   * because another race happened to stop it. */
  it("is let go of by every race, thirty-two at once", async () => {
    const races = Array.from({ length: 32 }, () => answeringEndpoint([A, B, C, D]));
    await vi.runAllTimersAsync();
    const bases = await Promise.all(races);

    expect(bases.every((base) => base === B)).toBe(true);
    expect(handed).toHaveLength(32 * 4);
    expect(parked()).toEqual([]);
  });
});
