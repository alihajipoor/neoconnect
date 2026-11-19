import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayCall, RelayOutcome } from "./last-resort";
import type { DoorCall, DoorOutcome } from "./server-doors";
import type { ProtocolUser, Subscription } from "./types";

/** A screen's load of the credentials (`loadProtocolUsers`), through the
 * real request code down to the transport, the real cache down to the
 * store, and the real sign-out.
 *
 * The regression this is for, from the release run on the test machine
 * (2026-11-19): in 43 minutes of ordinary use the server answered 47
 * requests for the credentials and not one with a 304, and the cache held
 * no tag at the end. The loads asked without a tag and saved their answer
 * without one, so every load threw away the tag the config refresh had
 * kept -- and loads come far more often than refreshes. */

type Reply = { kind: "unreachable" } | { kind: "respond"; status: number; body?: unknown; etag?: string };

const PATH = "/customer/protocol-users";
/** Answers for the credentials' requests over the names, in order. */
const replies: Reply[] = [];
/** Every request for the credentials over the names, with its headers. */
const calls: { url: string; headers: Record<string, string> }[] = [];

/** A response as `@tauri-apps/plugin-http` returns one, as far as api.ts
 * reads it; `headers.get` case-insensitive, as the real one is. */
function makeResponse(reply: Extract<Reply, { kind: "respond" }>): Response {
  const headers = new Map<string, string>();
  if (reply.etag !== undefined) headers.set("etag", reply.etag);
  if (reply.body !== undefined) headers.set("content-type", "application/json; charset=utf-8");
  return {
    ok: reply.status >= 200 && reply.status < 300,
    status: reply.status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    json: () =>
      reply.body === undefined
        ? Promise.reject(new SyntaxError("Unexpected end of JSON input"))
        : Promise.resolve(reply.body),
  } as unknown as Response;
}

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string, init?: { headers?: Record<string, string> }) => {
    // Only the credentials are answered from the queue. Anything asked on
    // the side -- the names' health probe after a door -- finds no route.
    if (!url.endsWith(PATH)) return Promise.reject(new Error(`no route to ${url}`));
    calls.push({ url, headers: { ...(init?.headers ?? {}) } });
    const reply = replies.shift();
    if (reply === undefined || reply.kind === "unreachable") return Promise.reject(new Error(`no route to ${url}`));
    return Promise.resolve(makeResponse(reply));
  },
}));

/** The Tauri store, in memory, one map per file. */
const files = new Map<string, Map<string, unknown>>();
function fileOf(name: string): Map<string, unknown> {
  let data = files.get(name);
  if (!data) {
    data = new Map<string, unknown>();
    files.set(name, data);
  }
  return data;
}
vi.mock("@tauri-apps/plugin-store", () => ({
  load: async (name: string) => {
    const data = fileOf(name);
    return {
      get: async (key: string) => data.get(key),
      set: async (key: string, value: unknown) => void data.set(key, value),
      delete: async (key: string) => void data.delete(key),
      save: async () => undefined,
    };
  },
}));

const BASE = "https://connect.neoxify.site/api";
vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve([BASE]),
  rememberEndpoint: () => Promise.resolve(),
  rememberedEndpoint: () => Promise.resolve(undefined),
  forgetEndpoint: () => Promise.resolve(),
}));
vi.mock("./endpoint-bundle-store", () => ({
  maybeRefreshBundle: () => Promise.resolve(),
  isKnownBlockPage: () => false,
  lastResortEntries: () => Promise.resolve([]),
  maybeRefreshBundleThroughRelay: () => Promise.resolve(),
}));
vi.mock("./session", () => ({
  getTokens: () => Promise.resolve({ accessToken: "access", refreshToken: "refresh" }),
  setTokens: () => Promise.resolve(),
  clearTokens: () => Promise.resolve(),
}));

/** The servers' doors and the relay, at the point api.ts hands them a
 * request: what they were asked with, and what they answer. */
const doorCalls: DoorCall[] = [];
let doorAnswer: DoorOutcome = { kind: "unanswered", spent: false };
vi.mock("./server-doors", async (orig) => ({
  ...(await orig<typeof import("./server-doors")>()),
  doorRequest: (call: DoorCall) => {
    doorCalls.push(call);
    return Promise.resolve(doorAnswer);
  },
}));
const relayCalls: RelayCall[] = [];
let relayAnswer: RelayOutcome = { kind: "unanswered" };
vi.mock("./last-resort", async (orig) => ({
  ...(await orig<typeof import("./last-resort")>()),
  relayRequest: (call: RelayCall) => {
    relayCalls.push(call);
    return Promise.resolve(relayAnswer);
  },
}));
// Reports are not what is under test, and are not sent.
vi.mock("./attempts", async (orig) => ({
  ...(await orig<typeof import("./attempts")>()),
  reportAttempt: () => Promise.resolve(),
}));

const { loadProtocolUsers, refreshConnectionConfig } = await import("./connection-config");
const { loadSnapshot, saveSnapshot, SNAPSHOT_TTL_MS } = await import("./credential-cache");
const { endCustomerSession, sessionGeneration, setTunnelTeardown } = await import("./session-end");
const { newTrace, renderTrace } = await import("./endpoint-trace");

/** The sign-out's tunnel teardown, set per test. */
let teardown: () => Promise<"down" | "unconfirmed"> = () => Promise.resolve("down");
setTunnelTeardown(() => teardown());

/** A REALITY credential. The host is a documentation address (RFC 5737);
 * node addresses are never committed. */
function reality(serverName: string): ProtocolUser {
  return {
    id: "pu-1",
    routeId: "route-1",
    protocol: "XRAY_VLESS_REALITY",
    connection: { host: "203.0.113.10", port: 443, transport: "TCP", security: "REALITY", publicParams: { serverName } },
  } as unknown as ProtocolUser;
}

const LIST = [reality("www.example.com")];
const CHANGED = [reality("www.example.org")];
/** The server's shape, byte for byte (customer.controller.ts). */
const TAG = 'W/"pu-abcdefghijklmnopqrstuvwxy12"';
const NEXT_TAG = 'W/"pu-zyxwvutsrqponmlkjihgfed98"';
const PLAN = { id: "sub-1", planId: "plan-1", status: "ACTIVE" } as Subscription;

type Loaded = Awaited<ReturnType<typeof loadProtocolUsers>>;

/** What both screens' loads write once everything has answered
 * (Dashboard.tsx, Windows and phone; their source is pinned below). */
async function saveAsTheScreensDo(loaded: Loaded, askedAt: number): Promise<void> {
  if (!loaded.ok) throw new Error(`the load failed: ${loaded.error}`);
  const sessionAtStart = sessionGeneration();
  await saveSnapshot(
    {
      subscription: PLAN,
      protocolUsers: loaded.data,
      ...(loaded.etag ? { protocolUsersEtag: loaded.etag } : {}),
      routes: [],
      askedAt,
    },
    () => sessionGeneration() === sessionAtStart,
  );
}

/** A cached list with its tag, as a load or a refresh leaves it. */
async function seed(etag: string | null): Promise<void> {
  await saveSnapshot({
    subscription: PLAN,
    protocolUsers: LIST,
    ...(etag ? { protocolUsersEtag: etag } : {}),
    routes: [],
  });
}

/** The cached list, made older than the freshness horizon: what a refresh
 * finds ten minutes on. */
function ageSnapshot(): void {
  const data = fileOf("connection-cache.json");
  data.set("snapshot", { ...(data.get("snapshot") as object), savedAt: Date.now() - SNAPSHOT_TTL_MS - 1 });
}

/** The validator a request carried, in whatever casing. */
function offered(headers: Record<string, string> | undefined): string | undefined {
  return Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "if-none-match")?.[1];
}

beforeEach(() => {
  for (const data of files.values()) data.clear();
  replies.length = 0;
  calls.length = 0;
  doorCalls.length = 0;
  relayCalls.length = 0;
  doorAnswer = { kind: "unanswered", spent: false };
  relayAnswer = { kind: "unanswered" };
  teardown = () => Promise.resolve("down");
});

describe("a screen's load of the credentials", () => {
  it("asks with no tag when nothing is cached, and keeps the tag of its 200", async () => {
    replies.push({ kind: "respond", status: 200, body: LIST, etag: TAG });
    const askedAt = Date.now();

    const loaded = await loadProtocolUsers();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}${PATH}`);
    expect(offered(calls[0].headers)).toBeUndefined();
    expect(loaded).toEqual({ ok: true, data: LIST, etag: TAG });
    // Saved as the screens save it: the tag stays beside the list.
    await saveAsTheScreensDo(loaded, askedAt);
    const cached = (await loadSnapshot())!;
    expect(cached.protocolUsers).toEqual(LIST);
    expect(cached.protocolUsersEtag).toBe(TAG);
  });

  it("offers the cached list's tag, and on a 304 the cached list is the answer", async () => {
    await seed(TAG);
    replies.push({ kind: "respond", status: 304, etag: TAG });
    const trace = newTrace();

    const loaded = await loadProtocolUsers(trace);

    expect(calls).toHaveLength(1);
    expect(offered(calls[0].headers)).toBe(TAG);
    expect(loaded).toEqual({ ok: true, data: LIST, etag: TAG });
    // An answer in the trace, as a 200 is: the load's report reads it.
    expect(renderTrace(trace)).toMatch(/^req: connect\.neoxify\.site=h304@\d+$/);
    // Saved again as a 200 with that body would be: same list, same tag.
    await saveAsTheScreensDo(loaded, Date.now());
    const cached = (await loadSnapshot())!;
    expect(cached.protocolUsers).toEqual(LIST);
    expect(cached.protocolUsersEtag).toBe(TAG);
  });

  it("takes a changed list and its new tag on a 200", async () => {
    await seed(TAG);
    replies.push({ kind: "respond", status: 200, body: CHANGED, etag: NEXT_TAG });

    const loaded = await loadProtocolUsers();

    expect(offered(calls[0].headers)).toBe(TAG);
    expect(loaded).toEqual({ ok: true, data: CHANGED, etag: NEXT_TAG });
  });

  it("asks as it always did when the cache has no tag, or no list the app could use", async () => {
    await seed(null);
    replies.push({ kind: "respond", status: 200, body: LIST, etag: TAG });
    expect(await loadProtocolUsers()).toEqual({ ok: true, data: LIST, etag: TAG });
    expect(offered(calls[0].headers)).toBeUndefined();

    // A tag beside a credential that cannot build a tunnel: the offline
    // start refuses such a list, so a 304 must never hand it to the screen.
    fileOf("connection-cache.json").set("snapshot", {
      version: 1,
      savedAt: Date.now(),
      subscription: PLAN,
      protocolUsers: [{ id: "pu-1", protocol: "XRAY_VLESS_REALITY" }],
      protocolUsersEtag: TAG,
      routes: [],
    });
    replies.push({ kind: "respond", status: 200, body: LIST, etag: TAG });
    await loadProtocolUsers();
    expect(calls).toHaveLength(2);
    expect(offered(calls[1].headers)).toBeUndefined();
  });

  it("still reports a failure as a failure, with the cached list left alone", async () => {
    await seed(TAG);
    replies.push({ kind: "respond", status: 500, body: { message: "unavailable" } });

    const loaded = await loadProtocolUsers();

    expect(loaded).toEqual({ ok: false, error: "unavailable", status: 500 });
    expect((await loadSnapshot())!.protocolUsersEtag).toBe(TAG);
  });
});

describe("a load and the session the cache belongs to", () => {
  it("offers no tag after a sign-out", async () => {
    await seed(TAG);
    await endCustomerSession();
    replies.push({ kind: "respond", status: 200, body: CHANGED, etag: NEXT_TAG });

    const loaded = await loadProtocolUsers();

    // A request was made -- without it "no tag offered" proves nothing.
    expect(calls).toHaveLength(1);
    expect(offered(calls[0].headers)).toBeUndefined();
    expect(loaded).toEqual({ ok: true, data: CHANGED, etag: NEXT_TAG });
  });

  /** The cache read lands after a sign-out began and before it cleared the
   * cache: the list found is the ended session's, and is not offered. */
  it("offers no tag it read across a sign-out", async () => {
    await seed(TAG);
    let release: () => void = () => undefined;
    teardown = () => new Promise((resolve) => (release = () => resolve("down")));
    replies.push({ kind: "respond", status: 200, body: CHANGED, etag: NEXT_TAG });

    const loading = loadProtocolUsers();
    const ending = endCustomerSession();
    await loading;

    // Still on disk when the load read it: the sign-out had not got that
    // far, so only the session generation kept it from being offered.
    expect((await loadSnapshot())?.protocolUsersEtag).toBe(TAG);
    expect(calls).toHaveLength(1);
    expect(offered(calls[0].headers)).toBeUndefined();

    release();
    await ending;
    expect(await loadSnapshot()).toBeNull();
  });
});

/** The regression, end to end through the cache: a load, then the config
 * refresh ten minutes on. */
describe("a refresh after a load", () => {
  it("control: saved without the tag, as the loads used to, the refresh had none to offer", async () => {
    replies.push({ kind: "respond", status: 200, body: LIST, etag: TAG });
    const loaded = await loadProtocolUsers();
    if (!loaded.ok) throw new Error("the load failed");
    await saveSnapshot({ subscription: PLAN, protocolUsers: loaded.data, routes: [], askedAt: Date.now() });
    ageSnapshot();
    replies.push({ kind: "respond", status: 200, body: LIST, etag: TAG });

    await refreshConnectionConfig({ held: loaded.data });

    expect(calls).toHaveLength(2);
    expect(offered(calls[1].headers)).toBeUndefined();
  });

  it("offers the tag the load kept and gets its 304, and the next load offers it again", async () => {
    replies.push({ kind: "respond", status: 200, body: LIST, etag: TAG });
    const askedAt = Date.now();
    const loaded = await loadProtocolUsers();
    await saveAsTheScreensDo(loaded, askedAt);
    if (!loaded.ok) throw new Error("the load failed");
    ageSnapshot();
    const agedAt = (await loadSnapshot())!.savedAt;
    replies.push({ kind: "respond", status: 304, etag: TAG });

    const refreshed = await refreshConnectionConfig({ held: loaded.data });

    expect(calls).toHaveLength(2);
    expect(offered(calls[1].headers)).toBe(TAG);
    expect(refreshed.source).toBe("network");
    expect(refreshed.protocolUsers).toEqual(LIST);
    // The refresh's write keeps the tag, with the horizon started again.
    await vi.waitFor(async () => {
      const cached = (await loadSnapshot())!;
      expect(cached.savedAt).toBeGreaterThan(agedAt);
      expect(cached.protocolUsersEtag).toBe(TAG);
    });

    // And the load after it: the tag is handed on, not lost.
    replies.push({ kind: "respond", status: 304, etag: TAG });
    expect(await loadProtocolUsers()).toEqual({ ok: true, data: LIST, etag: TAG });
    expect(offered(calls[2].headers)).toBe(TAG);
  });
});

/** Only the names are offered the tag: an answer through a door or the
 * relay is read by `relayResult`, which takes a 304 for a failure. Last in
 * the file, because the names are left failing. */
describe("a load through the doors and the relay", () => {
  const answer = (users: ProtocolUser[]) => ({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(users),
  });

  it("asks the doors and the relay without the tag, and brings back none", async () => {
    await seed(TAG);
    replies.push({ kind: "unreachable" });
    relayAnswer = { kind: "answered", answer: answer(CHANGED) };

    const loaded = await loadProtocolUsers();

    // The names were offered it, and failed.
    expect(offered(calls[0].headers)).toBe(TAG);
    expect(doorCalls.map((c) => c.path)).toEqual([PATH]);
    expect(offered(doorCalls[0].headers)).toBeUndefined();
    expect(relayCalls.map((c) => c.path)).toEqual([PATH]);
    expect(offered(relayCalls[0].headers)).toBeUndefined();
    expect(loaded).toEqual({ ok: true, data: CHANGED, etag: null });
    // So the screens save the list with no tag, and the next asks plainly.
    await saveAsTheScreensDo(loaded, Date.now());
    expect((await loadSnapshot())!.protocolUsersEtag).toBeUndefined();
  });

  it("takes a door's answer the same way, with the relay not asked", async () => {
    await seed(TAG);
    replies.push({ kind: "unreachable" });
    doorAnswer = { kind: "answered", answer: answer(CHANGED), door: "192.0.2.10:2053" };

    const loaded = await loadProtocolUsers();

    expect(doorCalls).toHaveLength(1);
    expect(offered(doorCalls[0].headers)).toBeUndefined();
    expect(relayCalls).toHaveLength(0);
    expect(loaded).toEqual({ ok: true, data: CHANGED, etag: null });
  });
});

/** Read from the source, because the screens have no harness of their own:
 * both loads ask through `loadProtocolUsers` and save its tag beside the
 * list, and no other request for the credentials is left to ask without a
 * tag. */
describe("both screens' loads", () => {
  const screens = [
    ["Windows", "../screens/Dashboard.tsx"],
    ["phone", "../../../mobile/src/screens/Dashboard.tsx"],
  ] as const;

  it.each(screens)("the %s dashboard asks with the tag and saves the answer's", (_name, path) => {
    const screen = readFileSync(new URL(path, import.meta.url), "utf8");
    expect(screen).toContain('loadProtocolUsers(requests.trace("protocol-users")),');
    // One write of the snapshot, and it carries the tag.
    expect(screen.split("saveSnapshot(").length - 1).toBe(1);
    const write = screen.indexOf("void saveSnapshot(");
    const written = screen.slice(write, screen.indexOf(");", write));
    expect(written).toContain("protocolUsers: usersResult.data,");
    expect(written).toContain("...(usersResult.etag ? { protocolUsersEtag: usersResult.etag } : {}),");
  });

  it("has no request for the credentials that offers no tag", () => {
    const customer = readFileSync(new URL("./customer.ts", import.meta.url), "utf8");
    expect(customer.match(/"\/customer\/protocol-users"/g)).toHaveLength(1);
    expect(customer).toContain('apiRequestRevalidated<ProtocolUser[]>("/customer/protocol-users", etag,');
  });
});
