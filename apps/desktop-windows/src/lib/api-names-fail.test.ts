import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayAnswer } from "./last-resort";

/** A read on a network where none of the API's names resolves to a public
 * address: when it stops waiting for them and asks the backup route, and
 * every case where it must not (`ordinaryUnlessNamesFail` in api.ts). The
 * relay's policy and the look are real, over a fake command, resolver and
 * HTTP plugin. An address that "hangs" here is what such a name does: no
 * answer until its request is stopped. */

type Reply =
  | { status: number; body?: unknown; afterMs?: number }
  | "unreachable"
  /** Never answers; rejects when its request is stopped. */
  | "hang"
  /** Hangs, then fails by itself: a connection deadline, shortened. */
  | { failAfterMs: number };
const replies: Record<string, Reply[]> = {};
/** What happened, in order: every request sent, stopped or failed, every
 * look at the names, every relay call. */
const events: string[] = [];

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string, options?: { signal?: AbortSignal }) => {
    const { hostname, pathname } = new URL(url);
    events.push(`fetch ${hostname} ${pathname}`);
    const reply = replies[`${hostname} ${pathname}`]?.shift() ?? "unreachable";
    if (reply === "unreachable") return Promise.reject(new Error(`error sending request for url (${url})`));
    const answer = (r: { status: number; body?: unknown }) =>
      new Response(r.body === undefined ? null : JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const fail = (how: string) => {
        if (settled) return;
        settled = true;
        events.push(`${how} ${hostname}`);
        reject(new Error("Request cancelled"));
      };
      options?.signal?.addEventListener("abort", () => fail("stopped"));
      if (reply === "hang") return;
      if ("failAfterMs" in reply) {
        setTimeout(() => fail("failed"), reply.failAfterMs);
        return;
      }
      setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(answer(reply));
      }, reply.afterMs ?? 0);
    });
  },
}));
vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve(["https://a.example/api", "https://b.example:2053/api"]),
  rememberEndpoint: () => Promise.resolve(),
  rememberedEndpoint: () => Promise.resolve(undefined),
  forgetEndpoint: () => Promise.resolve(),
}));
const RELAY = { url: "https://192.0.2.10/api", pins: [`sha256/${btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))}`] };
let relays = [RELAY];
vi.mock("./endpoint-bundle-store", () => ({
  maybeRefreshBundle: () => Promise.resolve(),
  lastResortEntries: () => Promise.resolve(relays),
  maybeRefreshBundleThroughRelay: () => Promise.resolve(),
  isKnownBlockPage: (address: string) => /^10\.10\.34\./.test(address),
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

const { apiRequest, everyRouteFailed, publicRequest, resetRaceWinnerForTests } = await import("./api");
const lr = await import("./last-resort");
const names = await import("./names-check");
const { newTrace, renderTrace } = await import("./endpoint-trace");

let relayReplies: (RelayAnswer | string)[] = [];
let now = 5_000_000;
let tunnelUp: boolean | null = false;
/** What the resolver says about each name, by name; and how long it takes. */
let resolved: Record<string, string> = {};
let resolveAfterMs = 0;

const json = (status: number, body: unknown): RelayAnswer => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
const ME = { id: "c1", email: "a@example.com" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const count = (prefix: string) => events.filter((event) => event.startsWith(prefix)).length;

/** Every name answered with an address of the network's own. */
const NONE_PUBLIC = { "a.example": "not-public", "b.example": "not-public" };

beforeEach(() => {
  resetRaceWinnerForTests();
  for (const key of Object.keys(replies)) delete replies[key];
  events.length = 0;
  store.clear();
  relays = [RELAY];
  relayReplies = [];
  now = 5_000_000;
  tunnelUp = false;
  resolved = NONE_PUBLIC;
  resolveAfterMs = 0;
  stored = { accessToken: "access", refreshToken: "refresh" };
  lr.resetLastResortForTests({
    now: () => now,
    tunnelUp: () => Promise.resolve(tunnelUp),
    transport: async (args) => {
      events.push(`relay ${args.method} ${args.path}`);
      const reply = relayReplies.shift();
      if (reply === undefined) throw "relay: connect-timeout";
      if (typeof reply === "string") throw reply;
      return reply;
    },
  });
  lr.setBackupRouteOn(true);
  names.resetNamesCheckForTests({
    now: () => now,
    // Not the half second a real request gets: these tests would take it.
    afterMs: 5,
    resolve: async (hosts) => {
      events.push(`look ${hosts.join(",")}`);
      if (resolveAfterMs > 0) await sleep(resolveAfterMs);
      return hosts.map((host) => resolved[host] ?? "no-answer");
    },
  });
});

describe("a read whose names do not resolve to a public address here", () => {
  it("stops waiting for them and is answered through the backup route", async () => {
    replies["a.example /api/customer/me"] = ["hang"];
    relayReplies = [json(200, ME)];
    const started = Date.now();
    expect(await apiRequest("/customer/me", { relay: "background" })).toEqual({ ok: true, data: ME });
    // Nowhere near a connection deadline: the look, and the relay.
    expect(Date.now() - started).toBeLessThan(1_000);
    // The race is stopped before the relay is asked, never beside it.
    expect(events).toEqual([
      "fetch a.example /api/customer/me",
      "look a.example,b.example",
      "stopped a.example",
      "relay GET /customer/me",
    ]);
    expect(names.namesBlockedHere()).toBe(true);
  });

  it("counts a name the resolver gave no answer for, beside one it answered with nothing public", async () => {
    resolved = { "a.example": "not-public", "b.example": "no-answer" };
    replies["a.example /api/customer/me"] = ["hang"];
    relayReplies = [json(200, ME)];
    expect(await apiRequest("/customer/me", { relay: "background" })).toEqual({ ok: true, data: ME });
    expect(count("relay")).toBe(1);
  });

  it("starts relay mode by that answer, so the requests after it neither wait nor look", async () => {
    replies["a.example /api/customer/me"] = ["hang"];
    relayReplies = [json(200, ME), json(200, [])];
    await apiRequest("/customer/me", { relay: "background" });
    expect(lr.relayModeActive()).toBe(true);
    events.length = 0;
    expect(await apiRequest("/customer/subscriptions", { relay: "background" })).toEqual({ ok: true, data: [] });
    expect(events).toEqual(["relay GET /customer/subscriptions"]);
  });

  it("is looked at again when relay mode next asks the ordinary routes", async () => {
    replies["a.example /api/customer/me"] = ["hang", "hang"];
    relayReplies = [json(200, ME), json(200, ME)];
    await apiRequest("/customer/me", { relay: "background" });
    now += lr.NORMAL_PROBE_MS;
    events.length = 0;
    expect(await apiRequest("/customer/me", { relay: "background" })).toEqual({ ok: true, data: ME });
    expect(events).toEqual([
      "fetch a.example /api/customer/me",
      "look a.example,b.example",
      "stopped a.example",
      "relay GET /customer/me",
    ]);
  });

  it("goes the same way without a session: a public read", async () => {
    replies["a.example /api/health"] = ["hang"];
    relayReplies = [json(200, { status: "ok" })];
    expect(await publicRequest("/health", { relay: "background" })).toEqual({ ok: true, data: { status: "ok" } });
    expect(events[events.length - 2]).toBe("stopped a.example");
    expect(events[events.length - 1]).toBe("relay GET /health");
  });

  it("asks the ordinary routes again, in full, when the backup route has no answer", async () => {
    replies["a.example /api/customer/me"] = ["hang", { failAfterMs: 30 }];
    const trace = newTrace();
    const result = await apiRequest("/customer/me", { relay: "background" }, trace);
    // What failed is what was dialled to its end, and it says the backup
    // route was tried. The relay is not asked a second time.
    expect(result).toMatchObject({ ok: false, noResponse: true, relayTried: true });
    expect(events).toEqual([
      "fetch a.example /api/customer/me",
      "look a.example,b.example",
      "stopped a.example",
      "relay GET /customer/me",
      "fetch a.example /api/customer/me",
      "failed a.example",
      "fetch b.example /api/customer/me",
    ]);
    // The address the look stopped is marked for what is known about it --
    // how the names resolved -- and then its own attempt follows.
    expect(renderTrace(trace)).toMatch(/^req: a\.example=names@\d+ a\.example=net@\d+ b\.example:2053=net@\d+$/);
    expect(!result.ok && everyRouteFailed(result, trace)).toBe(true);
  });

  it("asks the ordinary routes again when the backend says the backup route is not for this network", async () => {
    replies["a.example /api/customer/me"] = ["hang", { status: 200, body: ME }];
    relayReplies = [json(403, { code: "RELAY_REGION", message: "not for this network" })];
    // Names that were only slow to resolve, somewhere the relay is not for:
    // the request is still answered where it always was.
    expect(await apiRequest("/customer/me", { relay: "background" })).toEqual({ ok: true, data: ME });
    expect(count("relay")).toBe(1);
    // And nothing looks again there for the day the relay is off.
    events.length = 0;
    replies["a.example /api/customer/me"] = [{ failAfterMs: 40 }];
    await apiRequest("/customer/me", { relay: "background" });
    expect(count("look")).toBe(0);
    expect(count("relay")).toBe(0);
  });
});

describe("a read with a name that resolves to a public address", () => {
  it("runs as it always has: the relay only after every address has failed", async () => {
    resolved = { "a.example": "not-public", "b.example": "public" };
    replies["a.example /api/customer/me"] = [{ failAfterMs: 60 }];
    relayReplies = [json(200, ME)];
    expect(await apiRequest("/customer/me", { relay: "background" })).toEqual({ ok: true, data: ME });
    expect(events).toEqual([
      "fetch a.example /api/customer/me",
      "look a.example,b.example",
      "failed a.example",
      "fetch b.example /api/customer/me",
      "relay GET /customer/me",
    ]);
    expect(names.namesBlockedHere()).toBe(false);
  });

  it("runs as it always has where the resolver has only not answered yet", async () => {
    // Slow names, or a link still coming up: not a network answering for
    // the names itself, and the request is left to find out.
    resolved = { "a.example": "no-answer", "b.example": "no-answer" };
    replies["a.example /api/customer/me"] = [{ status: 200, body: ME, afterMs: 60 }];
    relayReplies = [json(200, { id: "from the relay" })];
    expect(await apiRequest("/customer/me", { relay: "background" })).toEqual({ ok: true, data: ME });
    expect(events).toEqual(["fetch a.example /api/customer/me", "look a.example,b.example"]);
    expect(names.namesBlockedHere()).toBe(false);
  });

  it("is not looked at when it is answered inside its head start", async () => {
    names.resetNamesCheckForTests({
      afterMs: 200,
      resolve: async (hosts) => {
        events.push(`look ${hosts.join(",")}`);
        return hosts.map(() => "not-public");
      },
    });
    replies["a.example /api/customer/me"] = [{ status: 200, body: ME, afterMs: 20 }];
    expect(await apiRequest("/customer/me", { relay: "background" })).toEqual({ ok: true, data: ME });
    await sleep(250);
    expect(events).toEqual(["fetch a.example /api/customer/me"]);
  });

  it("keeps its answer when one arrives while the names are being looked at", async () => {
    // The resolver says no name is public, and a name answers anyway: the
    // answer is the answer, and the names are not held to be failing.
    resolveAfterMs = 80;
    replies["a.example /api/customer/me"] = [{ status: 200, body: ME, afterMs: 30 }];
    relayReplies = [json(200, { id: "from the relay" })];
    expect(await apiRequest("/customer/me", { relay: "background" })).toEqual({ ok: true, data: ME });
    await sleep(120);
    expect(count("relay")).toBe(0);
    expect(count("stopped")).toBe(0);
    expect(names.namesBlockedHere()).toBe(false);
  });
});

describe("where the backup route may not be used, nothing looks and nothing changes", () => {
  /** A request that fails by itself after a while, as it would have. */
  const ordinary = async (path = "/customer/me", init: Parameters<typeof apiRequest>[1] = { relay: "background" }) => {
    replies[`a.example /api${path}`] = [{ failAfterMs: 60 }];
    return await apiRequest(path, init);
  };

  it("with a tunnel up", async () => {
    tunnelUp = true;
    const result = await ordinary();
    expect(result.ok).toBe(false);
    expect(count("look")).toBe(0);
    expect(count("stopped")).toBe(0);
    expect(count("relay")).toBe(0);
  });

  it("with a tunnel that cannot be read", async () => {
    tunnelUp = null;
    await ordinary();
    expect(count("look")).toBe(0);
    expect(count("stopped")).toBe(0);
  });

  it("with the backup route switched off in Settings", async () => {
    lr.setBackupRouteOn(false);
    await ordinary();
    expect(count("look")).toBe(0);
    expect(count("relay")).toBe(0);
  });

  it("with no relay in the signed list", async () => {
    relays = [];
    await ordinary();
    expect(count("look")).toBe(0);
  });

  it("for a call the relay does not carry", async () => {
    await ordinary("/customer/devices");
    expect(count("look")).toBe(0);
    expect(count("relay")).toBe(0);
  });

  it("for a request that did not opt into the relay", async () => {
    await ordinary("/customer/me", {});
    expect(count("look")).toBe(0);
    expect(count("relay")).toBe(0);
  });

  it("for a write, which may not be sent twice", async () => {
    replies["a.example /api/health"] = [{ failAfterMs: 60 }];
    relayReplies = [json(200, { ok: true })];
    await apiRequest("/customer/vouchers/redeem", { method: "POST", body: "{}", relay: "foreground" });
    expect(count("look")).toBe(0);
    expect(count("stopped")).toBe(0);
  });

  it("in a build without the command", async () => {
    names.resetNamesCheckForTests({
      afterMs: 5,
      resolve: () => Promise.reject(new Error("command names_resolve_public not found")),
    });
    relayReplies = [json(200, ME)];
    // As before: every address to its own end, then the relay.
    expect(await ordinary()).toEqual({ ok: true, data: ME });
    expect(count("stopped")).toBe(0);
    expect(events[events.length - 1]).toBe("relay GET /customer/me");
    expect(names.namesBlockedHere()).toBe(false);
  });
});
