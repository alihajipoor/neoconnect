import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayAnswer } from "./last-resort";
import type { ServerDoor } from "./types";

/** Where api.ts turns to the servers' doors, and where it must not: the
 * owner's order is names first for everyone, doors once the names have
 * failed as only blocking explains, and the relay of last resort after
 * the doors (docs/reachability.md, "Server doors"). The doors' own
 * policy is server-doors.test.ts's; here it is real, with a fake command
 * underneath, beside the real relay policy with a fake command of its
 * own. */

type Reply = { status: number; body?: unknown } | "unreachable" | "scope";
const replies: Record<string, Reply[]> = {};
/** Everything that was sent, in order, by which kind of route. */
let events: string[] = [];

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string) => {
    const path = url.replace("https://a.example", "");
    events.push(`name ${path}`);
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
vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve(["https://a.example"]),
  rememberEndpoint: () => Promise.resolve(),
  rememberedEndpoint: () => Promise.resolve(undefined),
  forgetEndpoint: () => Promise.resolve(),
}));
const pin = (fill: number) => `sha256/${btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)))}`;
const RELAY = { url: "https://192.0.2.200/api", pins: [pin(7)] };
let relayKnown = true;
vi.mock("./endpoint-bundle-store", () => ({
  maybeRefreshBundle: () => Promise.resolve(),
  lastResortEntries: () => Promise.resolve(relayKnown ? [RELAY] : []),
  maybeRefreshBundleThroughRelay: () => Promise.resolve(),
}));
vi.mock("./network-identity", () => ({
  networkKeyFromAsn: () => "asn:64500",
  stampedCountry: () => null,
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

const {
  apiRequest,
  onBackendAnswer,
  publicRequest,
  RENEWAL_FAILED,
  resetRaceWinnerForTests,
  STOPPED_ANSWERING,
  unreachable,
} = await import("./api");
const lr = await import("./last-resort");
const doors = await import("./server-doors");
const list = await import("./door-list");
const { newTrace, renderTrace } = await import("./endpoint-trace");
const { onSessionRevoked } = await import("./session-revoked");

const NAME = "www.example.org";
const A: ServerDoor = { host: "192.0.2.10", port: 2053, pins: [pin(1)], sni: NAME };
const B: ServerDoor = { host: "198.51.100.20", port: 2096, pins: [pin(2)], sni: null };
const usersWith = (...held: ServerDoor[]) =>
  held.map((door, i) => ({ id: `pu-${i}`, protocol: "XRAY_VLESS_TLS", connection: { host: door.host, port: 443, door } }));

type Carried = { host?: string; method: string; path: string; headers: Record<string, string>; body: string | null };
let throughDoor: Carried[] = [];
let doorReplies: Record<string, (RelayAnswer | string)[]> = {};
let throughRelay: Carried[] = [];
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
  events = [];
  store.clear();
  throughDoor = [];
  doorReplies = {};
  throughRelay = [];
  relayReplies = [];
  relayKnown = true;
  now = 5_000_000;
  tunnelUp = false;
  revoked = 0;
  stored = { accessToken: "access", refreshToken: "refresh" };
  lr.resetLastResortForTests({
    now: () => now,
    tunnelUp: () => Promise.resolve(tunnelUp),
    transport: async (args) => {
      events.push(`relay ${args.path}`);
      throughRelay.push(args);
      const reply = relayReplies.shift();
      if (reply === undefined) throw "relay: connect-timeout";
      if (typeof reply === "string") throw reply;
      return reply;
    },
  });
  lr.setBackupRouteOn(true);
  list.resetDoorListForTests();
  list.rememberDoors(usersWith(A, B));
  doors.resetServerDoorsForTests({
    now: () => now,
    transport: async (args) => {
      events.push(`door ${args.host} ${args.path}`);
      throughDoor.push(args);
      const reply = doorReplies[args.host]?.shift();
      if (reply === undefined) throw "door: connect-timeout";
      if (typeof reply === "string") throw reply;
      return reply;
    },
  });
});

const ME = { id: "c1", email: "a@example.com" };
const UNREACHABLE = unreachable();

describe("the order: names, then doors, then the relay", () => {
  it("asks the names first, the doors when they have failed, and the relay last", async () => {
    relayReplies = [json(200, ME)];
    const result = await apiRequest("/customer/me", { relay: "background" });
    expect(result).toEqual({ ok: true, data: ME });
    expect(events).toEqual([
      "name /customer/me",
      "door 192.0.2.10 /customer/me",
      "door 198.51.100.20 /customer/me",
      "relay /customer/me",
    ]);
  });

  it("stops at the door that answers, and never asks the relay", async () => {
    doorReplies[A.host] = [json(200, ME)];
    relayReplies = [json(200, { id: "from the relay" })];
    expect(await apiRequest("/customer/me", { relay: "background" })).toEqual({ ok: true, data: ME });
    expect(events).toEqual(["name /customer/me", "door 192.0.2.10 /customer/me"]);
  });

  it("never asks a door when a name answers, whatever the answer", async () => {
    replies["/customer/me"] = [{ status: 200, body: ME }, { status: 500, body: { message: "boom" } }, "scope"];
    doorReplies[A.host] = [json(200, { id: "from a door" })];
    expect(await apiRequest("/customer/me")).toEqual({ ok: true, data: ME });
    expect((await apiRequest<unknown>("/customer/me")).ok).toBe(false);
    // Refused by this app's own permission: not the network's doing, and
    // a door would not show otherwise.
    expect((await apiRequest<unknown>("/customer/me")).ok).toBe(false);
    expect(throughDoor).toEqual([]);
    expect(doors.askDoorsFirst()).toBe(false);
  });

  it("carries a call the relay does not, with no opt-in", async () => {
    // The account's devices are not on the relay's list. A door is the
    // mirror by name reached another way, and carries the whole API.
    const devices = { inUseKnown: true, devices: [] };
    doorReplies[A.host] = [json(200, devices), { status: 204, contentType: "", body: "" }];
    expect(await apiRequest("/customer/devices")).toEqual({ ok: true, data: devices });
    expect(await apiRequest("/customer/devices/d1", { method: "DELETE" })).toEqual({ ok: true, data: undefined });
    expect(throughRelay).toEqual([]);
    expect(throughDoor.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /customer/devices", "DELETE /customer/devices/d1"]);
  });

  it("ends relay mode: where a door answers, the relay is not needed", async () => {
    // The names are blocked and no door is known yet: the relay answers,
    // and brings the server list with its doors.
    list.forgetDoors();
    relayReplies = [json(200, ME)];
    await apiRequest("/customer/me", { relay: "background" });
    expect(lr.relayModeActive()).toBe(true);
    list.rememberDoors(usersWith(A, B));
    doorReplies[A.host] = [json(200, { inUseKnown: true, devices: [] }), json(200, ME)];
    events = [];
    expect((await apiRequest<unknown>("/customer/devices")).ok).toBe(true);
    expect(lr.relayModeActive()).toBe(false);
    expect(doors.askDoorsFirst()).toBe(true);
    // And a request that opted into the relay goes to the door now.
    expect(await apiRequest("/customer/me", { relay: "background" })).toEqual({ ok: true, data: ME });
    expect(events).toEqual(["name /customer/devices", "door 192.0.2.10 /customer/devices", "door 192.0.2.10 /customer/me"]);
  });

  it("carries a public request too", async () => {
    doorReplies[A.host] = [{ status: 204, contentType: "", body: "" }];
    const report = await publicRequest<void>("/client-attempts", { method: "POST", body: '{"a":1}' });
    expect(report).toEqual({ ok: true, data: undefined });
    expect(throughDoor[0]).toMatchObject({ method: "POST", path: "/client-attempts", body: '{"a":1}' });
    expect(throughDoor[0].headers.authorization).toBeUndefined();
  });
});

describe("with no door known", () => {
  beforeEach(() => list.forgetDoors());

  it("a request that failed everywhere ends exactly as it did before doors", async () => {
    expect(await apiRequest("/customer/devices")).toEqual(UNREACHABLE);
    expect(events).toEqual(["name /customer/devices"]);
  });

  it("and one that opted in goes straight on to the relay", async () => {
    relayReplies = [json(200, ME)];
    expect(await apiRequest("/customer/me", { relay: "background" })).toEqual({ ok: true, data: ME });
    expect(events).toEqual(["name /customer/me", "relay /customer/me"]);
    relayReplies = [];
    now += lr.RELAY_MODE_MS;
    expect(await apiRequest("/customer/me", { relay: "background" })).toEqual({ ...UNREACHABLE, relayTried: true });
    expect(throughDoor).toEqual([]);
  });

  it("a server list that carries no door is no door", async () => {
    list.rememberDoors([{ id: "pu-1", protocol: "WIREGUARD", connection: { host: "192.0.2.10", port: 51820 } }]);
    expect(await apiRequest("/customer/devices")).toEqual(UNREACHABLE);
    expect(throughDoor).toEqual([]);
  });
});

describe("a door that is not what the list says", () => {
  it("is refused for its key, the next is asked, and the trace says both", async () => {
    doorReplies[A.host] = ["door: pin-mismatch"];
    doorReplies[B.host] = [json(200, ME)];
    const trace = newTrace();
    expect(await apiRequest("/customer/me", undefined, trace)).toEqual({ ok: true, data: ME });
    expect(events).toEqual(["name /customer/me", "door 192.0.2.10 /customer/me", "door 198.51.100.20 /customer/me"]);
    expect(renderTrace(trace).replace(/@\d+/g, "@t")).toBe(
      "req: a.example=net@t; door: 192.0.2.10:2053=pin@t 198.51.100.20:2096=h200@t",
    );
  });

  it("a trace names only the doors that were asked", async () => {
    doorReplies[A.host] = [json(200, ME)];
    const trace = newTrace();
    await apiRequest("/customer/me", undefined, trace);
    expect(trace.doors?.map((attempt) => attempt.door)).toEqual(["192.0.2.10:2053"]);
    // And none when the names answered.
    replies["/customer/me"] = [{ status: 200, body: ME }];
    const quiet = newTrace();
    doors.noteNameAnswered();
    await apiRequest("/customer/me", undefined, quiet);
    expect(quiet.doors).toBeUndefined();
  });
});

describe("a signed-in request through a door", () => {
  it("carries the session, and renews it through the door when the backend says it has expired", async () => {
    doorReplies[A.host] = [
      json(401, { message: "Unauthorized" }),
      json(200, { accessToken: "access-2", refreshToken: "refresh-2" }),
      json(200, ME),
    ];
    expect(await apiRequest("/customer/me")).toEqual({ ok: true, data: ME });
    expect(throughDoor.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /customer/me",
      "POST /customer-auth/refresh",
      "GET /customer/me",
    ]);
    expect(throughDoor[0].headers.authorization).toBe("Bearer access");
    expect(JSON.parse(throughDoor[1].body ?? "")).toEqual({ refreshToken: "refresh" });
    expect(throughDoor[2].headers.authorization).toBe("Bearer access-2");
    expect(stored).toEqual({ accessToken: "access-2", refreshToken: "refresh-2" });
    expect(revoked).toBe(0);
  });

  it("ends the session when the backend refuses to renew it, once the door has shown it is the backend", async () => {
    doorReplies[A.host] = [
      json(401, { message: "Unauthorized" }),
      json(401, { message: "Unauthorized" }),
      json(200, { status: "ok" }),
    ];
    const result = await apiRequest("/customer/me");
    expect(result).toMatchObject({ ok: false, sessionExpired: true });
    expect(stored).toBeNull();
    expect(revoked).toBe(1);
    // The refusal was believed only after that same door answered the
    // public health check as the backend does.
    expect(throughDoor.map((c) => `${c.host} ${c.method} ${c.path}`)).toEqual([
      "192.0.2.10 GET /customer/me",
      "192.0.2.10 POST /customer-auth/refresh",
      "192.0.2.10 GET /health",
    ]);
  });

  it("believes at once a door the backend has already answered through", async () => {
    doorReplies[A.host] = [json(200, ME), json(401, { message: "Unauthorized" }), json(401, { message: "Unauthorized" })];
    await apiRequest("/customer/me");
    expect(await apiRequest("/customer/me")).toMatchObject({ ok: false, sessionExpired: true });
    expect(throughDoor.map((c) => c.path)).toEqual(["/customer/me", "/customer/me", "/customer-auth/refresh"]);
    expect(revoked).toBe(1);
  });

  /** A server whose mirror points at something that is not the API
   * answers 401 to everything, the health check included. Its key is
   * still the pinned one. Believed, it would sign the customer out on
   * the one network where they cannot sign in again. */
  it("does not end the session on the word of a door that answers 401 to everything", async () => {
    const no = json(401, { message: "Unauthorized" });
    doorReplies[A.host] = [no, no, no];
    const result = await apiRequest("/customer/me");
    expect(result).toEqual({ ok: false, error: RENEWAL_FAILED });
    expect(stored).toEqual({ accessToken: "access", refreshToken: "refresh" });
    expect(revoked).toBe(0);
    expect(doors.askDoorsFirst()).toBe(false);
    // And the next request asks another door first.
    throughDoor = [];
    doorReplies[B.host] = [json(200, ME)];
    expect(await apiRequest("/customer/me")).toEqual({ ok: true, data: ME });
    expect(throughDoor.map((c) => c.host)).toEqual([B.host]);
  });
});

describe("a write", () => {
  const redeem = () =>
    apiRequest<unknown>("/customer/vouchers/redeem", { method: "POST", body: '{"code":"X"}', relay: "foreground" });

  it("goes on to the next door when the first could not be connected to", async () => {
    doorReplies[B.host] = [json(201, { subscription: { id: "s1" } })];
    relayReplies = [json(201, { subscription: { id: "from the relay" } })];
    expect(await redeem()).toEqual({ ok: true, data: { subscription: { id: "s1" } } });
    expect(events).toEqual([
      "name /health",
      "door 192.0.2.10 /customer/vouchers/redeem",
      "door 198.51.100.20 /customer/vouchers/redeem",
    ]);
  });

  it("is never sent twice: one that went out through a door and got no answer goes nowhere else", async () => {
    doorReplies[A.host] = ["door: timeout"];
    doorReplies[B.host] = [json(201, {})];
    relayReplies = [json(201, {})];
    expect(await redeem()).toEqual({ ok: false, error: STOPPED_ANSWERING, noResponse: true });
    expect(events).toEqual(["name /health", "door 192.0.2.10 /customer/vouchers/redeem"]);
  });

  it("nor after a page that says the backend may have acted on it", async () => {
    doorReplies[A.host] = [{ status: 502, contentType: "text/html", body: "<html>bad gateway</html>" }];
    doorReplies[B.host] = [json(201, {})];
    relayReplies = [json(201, {})];
    expect(await redeem()).toMatchObject({ ok: false, status: 502, page: true });
    expect(events).toEqual(["name /health", "door 192.0.2.10 /customer/vouchers/redeem"]);
  });

  it("nor to the names, once doors go first", async () => {
    doorReplies[A.host] = [json(200, ME), "door: network"];
    await apiRequest("/customer/me");
    expect(doors.askDoorsFirst()).toBe(true);
    events = [];
    replies["/health"] = [{ status: 200, body: { status: "ok" } }];
    replies["/customer/vouchers/redeem"] = [{ status: 201, body: {} }];
    expect(await redeem()).toEqual({ ok: false, error: STOPPED_ANSWERING, noResponse: true });
    expect(events).toEqual(["door 192.0.2.10 /customer/vouchers/redeem"]);
  });
});

describe("once a door has answered on this network", () => {
  beforeEach(async () => {
    doorReplies[A.host] = [json(200, ME)];
    await apiRequest("/customer/me");
    events = [];
  });

  it("requests go to the doors first, and the names are not asked", async () => {
    doorReplies[A.host] = [json(200, ME), json(200, ME)];
    expect(await apiRequest("/customer/me")).toEqual({ ok: true, data: ME });
    expect(await apiRequest("/customer/me", { relay: "background" })).toEqual({ ok: true, data: ME });
    expect(events).toEqual(["door 192.0.2.10 /customer/me", "door 192.0.2.10 /customer/me"]);
  });

  it("the names are asked again in the background, and one answering puts them back in front", async () => {
    now += doors.NAMES_PROBE_MS;
    doorReplies[A.host] = [json(200, ME)];
    replies["/health"] = [{ status: 200, body: { status: "ok" } }];
    expect(await apiRequest("/customer/me")).toEqual({ ok: true, data: ME });
    // The request itself went through the door; the health check went to
    // the names on its own.
    expect(events).toContain("door 192.0.2.10 /customer/me");
    await vi.waitFor(() => expect(events).toContain("name /health"));
    await vi.waitFor(() => expect(doors.askDoorsFirst()).toBe(false));
    events = [];
    replies["/customer/me"] = [{ status: 200, body: ME }];
    expect(await apiRequest("/customer/me")).toEqual({ ok: true, data: ME });
    expect(events).toEqual(["name /customer/me"]);
  });

  it("the names still failing leaves the doors in front", async () => {
    now += doors.NAMES_PROBE_MS;
    doorReplies[A.host] = [json(200, ME), json(200, ME)];
    await apiRequest("/customer/me");
    await vi.waitFor(() => expect(events).toContain("name /health"));
    events = [];
    await apiRequest("/customer/me");
    expect(events).toEqual(["door 192.0.2.10 /customer/me"]);
  });

  it("the names are asked after all when no door answers, and then the relay", async () => {
    relayReplies = [json(200, ME)];
    expect(await apiRequest("/customer/me", { relay: "background" })).toEqual({ ok: true, data: ME });
    expect(events).toEqual([
      "door 192.0.2.10 /customer/me",
      "door 198.51.100.20 /customer/me",
      "name /customer/me",
      "relay /customer/me",
    ]);
  });

  it("is told to the screens as the backend answering", async () => {
    const heard: unknown[] = [];
    const off = onBackendAnswer((answer) => heard.push(answer));
    doorReplies[A.host] = [json(200, ME), json(401, { message: "Unauthorized" }), json(401, {})];
    await apiRequest("/customer/me");
    expect(heard).toEqual([{ read: true }]);
    // A 401 is not counted as hearing from the backend, by any route.
    await apiRequest("/customer/me");
    expect(heard).toEqual([{ read: true }]);
    off();
  });
});

describe("with a tunnel up", () => {
  it("nothing changes: no door is dialled, and the request ends as the names left it", async () => {
    tunnelUp = true;
    doorReplies[A.host] = [json(200, ME)];
    expect(await apiRequest("/customer/devices")).toEqual(UNREACHABLE);
    expect(await publicRequest("/health/ip")).toEqual(UNREACHABLE);
    expect(throughDoor).toEqual([]);
    expect(events).toEqual(["name /customer/devices", "name /health/ip"]);
  });

  it("coming up ends going to the doors first", async () => {
    doorReplies[A.host] = [json(200, ME), json(200, ME)];
    await apiRequest("/customer/me");
    expect(doors.askDoorsFirst()).toBe(true);
    tunnelUp = true;
    events = [];
    replies["/customer/me"] = [{ status: 200, body: ME }];
    expect(await apiRequest("/customer/me")).toEqual({ ok: true, data: ME });
    // Gated at the door, then by name -- through the tunnel, in the app.
    expect(events).toEqual(["name /customer/me"]);
    expect(doors.askDoorsFirst()).toBe(false);
  });
});

describe("a request with a deadline of its own", () => {
  it("that has passed is not offered to a door", async () => {
    const deadline = new AbortController();
    deadline.abort();
    doorReplies[A.host] = [json(200, ME)];
    const result = await apiRequest<unknown>("/customer/me", { signal: deadline.signal });
    expect(result.ok).toBe(false);
    expect(throughDoor).toEqual([]);
  });
});
