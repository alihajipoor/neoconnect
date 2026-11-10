import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayAnswer } from "./last-resort";
import type { ServerDoor } from "./types";

/** The servers' doors' own policy: which door a call goes to, in what
 * order, what a failure allows next, and what is remembered per network.
 * The transport is faked; the pin check, the server name and the limits
 * on a call are door_http.rs's tests, over real TLS. Where api.ts turns
 * to the doors is api-doors.test.ts. */

vi.mock("./endpoint-bundle-store", () => ({
  lastResortEntries: () => Promise.resolve([]),
  maybeRefreshBundleThroughRelay: () => Promise.resolve(),
}));

let network: string | null = "asn:64500";
vi.mock("./network-identity", () => ({
  networkKeyFromAsn: () => network,
}));

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const doors = await import("./server-doors");
const list = await import("./door-list");
const lr = await import("./last-resort");
const { ladderPass } = await import("./ladder-pass");
const { newTrace, renderTrace } = await import("./endpoint-trace");

const pin = (fill: number) => `sha256/${btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)))}`;
const NAME = "www.example.org";
const A: ServerDoor = { host: "192.0.2.10", port: 2053, pins: [pin(1)], sni: NAME };
const B: ServerDoor = { host: "198.51.100.20", port: 2096, pins: [pin(2), pin(3)], sni: null };
const C: ServerDoor = { host: "203.0.113.30", port: 2053, pins: [pin(4)], sni: NAME };
const D: ServerDoor = { host: "203.0.113.40", port: 2053, pins: [pin(5)], sni: NAME };

/** A server list as the API hands it out: a credential per door. */
const usersWith = (...held: ServerDoor[]) =>
  held.map((door, i) => ({ id: `pu-${i}`, protocol: "XRAY_VLESS_TLS", connection: { host: door.host, port: 443, door } }));

type Sent = {
  host: string;
  port: number;
  pins: string[];
  sni: string | null;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
  timeoutMs: number;
};
type Reply = ((args: Sent) => Promise<RelayAnswer>) | RelayAnswer | string;
let sent: Sent[] = [];
/** What each door answers, by address; a door with nothing left times
 * out connecting. */
let replies: Record<string, Reply[]> = {};
let now = 1_000_000;
let tunnelUp: boolean | null = false;

const json = (status: number, body: unknown): RelayAnswer => ({
  status,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify(body),
});
const page = (status: number): RelayAnswer => ({ status, contentType: "text/html", body: "<html></html>" });
const OK = json(200, { status: "ok" });

const GET = { method: "GET", path: "/customer/me" };
const mayHaveArrived = (status: number) => [502, 504, 520, 524].includes(status);
const WRITE = { method: "POST", path: "/customer/vouchers/redeem", body: "{}", mayHaveArrived };

beforeEach(() => {
  store.clear();
  network = "asn:64500";
  sent = [];
  replies = {};
  now = 1_000_000;
  tunnelUp = false;
  ladderPass.running.current = false;
  ladderPass.tunnelServer.current = null;
  lr.resetLastResortForTests({ now: () => now, tunnelUp: () => Promise.resolve(tunnelUp) });
  list.resetDoorListForTests();
  list.rememberDoors(usersWith(A, B, C, D));
  doors.resetServerDoorsForTests({
    now: () => now,
    transport: async (args) => {
      sent.push(args);
      const reply = replies[args.host]?.shift();
      if (reply === undefined) throw "door: connect-timeout";
      if (typeof reply === "string") throw reply;
      if (typeof reply === "function") return reply(args);
      return reply;
    },
  });
});

const asked = () => sent.map((s) => s.host);
const keyOf = (door: ServerDoor) => `${door.host}:${door.port}`;

describe("the doors a device holds", () => {
  it("are the ones in its server list, one per server and port", () => {
    const held = list.doorsFrom([
      ...usersWith(A, B),
      // A second credential on the same server carries the same door.
      ...usersWith(A),
      // A server with no door, as every server is from a backend that
      // hands out none.
      { id: "pu-x", protocol: "WIREGUARD", connection: { host: "203.0.113.99", port: 51820 } },
    ]);
    expect(held).toEqual([A, B]);
  });

  it("leave out anything that is not a whole door", () => {
    const bad: unknown[] = [
      null,
      "door",
      { ...A, host: "door.example.org" },
      { ...A, host: "192.0.2.010" },
      { ...A, host: "2001:db8::1" },
      { ...A, port: 0 },
      { ...A, port: 70000 },
      { ...A, port: "2053" },
      { ...A, pins: [] },
      { ...A, pins: [pin(1), pin(2), pin(3), pin(4)] },
      { ...A, pins: [pin(1), pin(1)] },
      { ...A, pins: ["sha256/short"] },
      { ...A, pins: "sha256/short" },
      { ...A, sni: "192.0.2.10" },
      { ...A, sni: "Not A Name" },
      { ...A, sni: 7 },
    ];
    expect(list.doorsFrom(bad.map((door) => ({ connection: { door } })))).toEqual([]);
    // No server name is a door that sends none.
    const { sni: _none, ...bare } = A;
    expect(list.doorsFrom([{ connection: { door: bare } }])).toEqual([{ ...A, sni: null }]);
  });

  it("are none once the list is gone", async () => {
    list.forgetDoors();
    expect(await doors.doorRequest(GET)).toEqual({ kind: "skipped" });
    expect(sent).toEqual([]);
  });
});

describe("one call through the doors", () => {
  it("is sent as the door says: its address, port, pins and server name", async () => {
    replies[A.host] = [OK];
    const outcome = await doors.doorRequest({ ...GET, headers: { authorization: "Bearer t" } });
    expect(outcome).toEqual({ kind: "answered", answer: OK, door: keyOf(A) });
    expect(sent).toEqual([
      {
        host: A.host,
        port: A.port,
        pins: A.pins,
        sni: NAME,
        method: "GET",
        path: "/customer/me",
        headers: { authorization: "Bearer t" },
        body: null,
        timeoutMs: doors.DOOR_CALL_MS,
      },
    ]);
  });

  it("refuses a door with the wrong key and asks the next", async () => {
    replies[A.host] = ["door: pin-mismatch"];
    replies[B.host] = [OK];
    const trace = newTrace();
    const outcome = await doors.doorRequest(WRITE, trace);
    expect(outcome).toEqual({ kind: "answered", answer: OK, door: keyOf(B) });
    expect(asked()).toEqual([A.host, B.host]);
    expect(sent[1].sni).toBeNull();
    expect(sent[1].pins).toEqual(B.pins);
    expect(renderTrace(trace, now)).toBe("door: 192.0.2.10:2053=pin@0 198.51.100.20:2096=h200@0");
  });

  it("asks at most three, and gives them twelve seconds between them", async () => {
    replies[A.host] = [
      async () => {
        now += 4_000;
        throw "door: connect-timeout";
      },
    ];
    replies[B.host] = [
      async () => {
        now += 4_000;
        throw "door: connect";
      },
    ];
    const trace = newTrace();
    expect(await doors.doorRequest(GET, trace)).toEqual({ kind: "unanswered", spent: false });
    // D was never asked, and is not said to have failed.
    expect(asked()).toEqual([A.host, B.host, C.host]);
    expect(sent.map((s) => s.timeoutMs)).toEqual([12_000, 8_000, 4_000]);
    expect(renderTrace(trace, now)).toBe(
      "door: 192.0.2.10:2053=timeout@4000 198.51.100.20:2096=net@4000 203.0.113.30:2053=timeout@0",
    );
  });

  it("stops when its time is spent, however many are left", async () => {
    replies[A.host] = [
      async () => {
        now += 12_000;
        throw "door: timeout";
      },
    ];
    expect(await doors.doorRequest(GET)).toEqual({ kind: "unanswered", spent: false });
    expect(asked()).toEqual([A.host]);
  });

  it("takes the backend's answer whatever its status, and a page from the server as no answer", async () => {
    replies[A.host] = [page(502)];
    replies[B.host] = [json(401, { message: "Unauthorized" })];
    const outcome = await doors.doorRequest(GET);
    expect(outcome).toEqual({ kind: "answered", answer: json(401, { message: "Unauthorized" }), door: keyOf(B) });
    expect(asked()).toEqual([A.host, B.host]);

    // A 204 has no type and no body, and is the backend's.
    const done: RelayAnswer = { status: 204, contentType: "", body: "" };
    replies[B.host] = [done];
    expect(await doors.doorRequest({ method: "DELETE", path: "/customer/devices/1", mayHaveArrived })).toEqual({
      kind: "answered",
      answer: done,
      door: keyOf(B),
    });
  });

  it("is not sent at all in a build with no door command", async () => {
    replies[A.host] = ["Command door_request not found", OK];
    const trace = newTrace();
    expect(await doors.doorRequest(GET, trace)).toEqual({ kind: "skipped" });
    expect(trace.doors).toBeUndefined();
    // And not looked for again in this run.
    expect(await doors.doorRequest(GET)).toEqual({ kind: "skipped" });
    expect(sent.length).toBe(1);
  });

  it("leaves a door this device cannot dial out, and says the network was not asked", async () => {
    replies[A.host] = ["door: bad-door"];
    replies[B.host] = [OK, OK];
    const trace = newTrace();
    expect((await doors.doorRequest(GET, trace)).kind).toBe("answered");
    expect(renderTrace(trace, now)).toBe("door: 192.0.2.10:2053=bad@0 198.51.100.20:2096=h200@0");
    sent = [];
    await doors.doorRequest(GET);
    expect(asked()).toEqual([B.host]);
    // The same door with other pins is another door.
    list.rememberDoors(usersWith({ ...A, pins: [pin(9)] }));
    replies[A.host] = [OK];
    sent = [];
    await doors.doorRequest(GET);
    expect(asked()).toEqual([A.host]);
  });
});

describe("a write that must not arrive twice", () => {
  it("goes on to the next door only where nothing was sent", async () => {
    for (const undelivered of ["door: connect-timeout", "door: connect", "door: tls", "door: pin-mismatch"]) {
      sent = [];
      doors.resetServerDoorsForTests({
        now: () => now,
        transport: async (args) => {
          sent.push(args);
          if (args.host === A.host) throw undelivered;
          return OK;
        },
      });
      expect((await doors.doorRequest(WRITE)).kind, undelivered).toBe("answered");
      expect(asked(), undelivered).toEqual([A.host, B.host]);
    }
  });

  it("ends at the first door that took it and did not answer", async () => {
    for (const sentOut of ["door: timeout", "door: network", "door: too-large", "door: bad-response", "door: not-utf8"]) {
      sent = [];
      doors.resetServerDoorsForTests({
        now: () => now,
        transport: async (args) => {
          sent.push(args);
          if (args.host === A.host) throw sentOut;
          return OK;
        },
      });
      expect(await doors.doorRequest(WRITE), sentOut).toEqual({ kind: "unanswered", spent: true });
      expect(asked(), sentOut).toEqual([A.host]);
    }
  });

  it("ends at a page that says the backend may have acted, and goes on after one that does not", async () => {
    replies[A.host] = [page(503)];
    replies[B.host] = [page(502)];
    replies[C.host] = [OK];
    expect(await doors.doorRequest(WRITE)).toEqual({ kind: "answered", answer: page(502), door: keyOf(B) });
    expect(asked()).toEqual([A.host, B.host]);
  });

  it("is a read's rule too only where the write may be sent again", async () => {
    // The token refresh: api.ts gives it no `mayHaveArrived`.
    replies[A.host] = ["door: timeout"];
    replies[B.host] = [page(502)];
    replies[C.host] = [OK];
    const refresh = { method: "POST", path: "/customer-auth/refresh", body: "{}" };
    expect(await doors.doorRequest(refresh)).toEqual({ kind: "answered", answer: OK, door: keyOf(C) });
    expect(asked()).toEqual([A.host, B.host, C.host]);
  });

  it("the errors after which nothing was sent are the ones door_http.rs names", () => {
    const rust = readFileSync(new URL("../../src-tauri/src/door_http.rs", import.meta.url), "utf8");
    const strings = new Map(
      [...rust.matchAll(/DoorError::(\w+) => "(door: [a-z0-9-]+)"/g)].map((m) => [m[1], m[2]] as const),
    );
    expect(strings.size).toBe(12);
    const rule = /pub fn undelivered\(self\) -> bool \{\s*matches!\(\s*self,([^)]*)\)/.exec(rust);
    if (!rule) throw new Error("undelivered not found in door_http.rs");
    const variants = [...rule[1].matchAll(/DoorError::(\w+)/g)].map((m) => strings.get(m[1]));
    expect(new Set(variants)).toEqual(new Set(doors.UNDELIVERED));
    expect(variants.length).toBe(doors.UNDELIVERED.size);
  });
});

describe("which door is asked first", () => {
  it("the list's order, when nothing else is known", async () => {
    replies[A.host] = [OK];
    await doors.doorRequest(GET);
    expect(asked()).toEqual([A.host]);
  });

  it("the server this device last connected through on this network", async () => {
    // A connect pass lands on C's server, and its tunnel is up as it ends.
    ladderPass.tunnelServer.current = { addresses: new Set([C.host]), reachedAround: true };
    tunnelUp = true;
    await doors.noteTunnelForDoors();
    // Later, with the tunnel down and no name answering:
    tunnelUp = false;
    replies[C.host] = ["door: connect-timeout"];
    replies[A.host] = [OK];
    await doors.doorRequest(GET);
    expect(asked()).toEqual([C.host, A.host]);

    // On another network that server has no such place.
    network = "asn:64501";
    sent = [];
    replies[A.host] = [OK];
    await doors.doorRequest(GET);
    expect(asked()).toEqual([A.host]);
  });

  it("is not learned from a pass that left no tunnel up", async () => {
    ladderPass.tunnelServer.current = { addresses: [C.host], reachedAround: false };
    tunnelUp = false;
    await doors.noteTunnelForDoors();
    replies[A.host] = [OK];
    await doors.doorRequest(GET);
    expect(asked()).toEqual([A.host]);
  });

  it("then the door that last answered here, with the ones that just failed last", async () => {
    replies[B.host] = [OK, OK];
    await doors.doorRequest(GET);
    expect(asked()).toEqual([A.host, B.host]);
    // A failed a moment ago and B answered: B leads, and A is behind
    // the doors that have not been asked.
    sent = [];
    await doors.doorRequest(GET);
    expect(asked()).toEqual([B.host]);
    sent = [];
    expect((await doors.doorRequest(GET)).kind).toBe("unanswered");
    expect(asked()).toEqual([B.host, C.host, D.host]);
  });
});

describe("with a tunnel", () => {
  it("up, no door is dialled", async () => {
    tunnelUp = true;
    replies[A.host] = [OK];
    const trace = newTrace();
    expect(await doors.doorRequest(GET, trace)).toEqual({ kind: "gated" });
    expect(sent).toEqual([]);
    expect(trace.doors).toBeUndefined();
  });

  it("being brought up, or one that cannot be read, no door is dialled either", async () => {
    ladderPass.running.current = true;
    ladderPass.startedAt.current = Date.now();
    expect(await doors.doorRequest(GET)).toEqual({ kind: "gated" });
    ladderPass.running.current = false;
    tunnelUp = null;
    expect(await doors.doorRequest(GET)).toEqual({ kind: "gated" });
    expect(sent).toEqual([]);
  });

  it("coming up between two doors, the second is not dialled", async () => {
    replies[A.host] = [
      async () => {
        tunnelUp = true;
        throw "door: connect-timeout";
      },
    ];
    replies[B.host] = [OK];
    expect(await doors.doorRequest(GET)).toEqual({ kind: "gated" });
    expect(asked()).toEqual([A.host]);
  });

  it("no door is dialled in a build that cannot read its tunnel", async () => {
    lr.resetLastResortForTests({ now: () => now });
    expect(await doors.doorRequest(GET)).toEqual({ kind: "skipped" });
    expect(sent).toEqual([]);
  });
});

describe("what is remembered per network", () => {
  it("doors that answered are asked first there for fifteen minutes, and not elsewhere", async () => {
    expect(doors.askDoorsFirst()).toBe(false);
    replies[A.host] = [OK];
    await doors.doorRequest(GET);
    expect(doors.askDoorsFirst()).toBe(true);
    network = "asn:64501";
    expect(doors.askDoorsFirst()).toBe(false);
    network = "asn:64500";
    now += doors.DOOR_MODE_MS - 1;
    expect(doors.askDoorsFirst()).toBe(true);
    now += 1;
    expect(doors.askDoorsFirst()).toBe(false);
  });

  it("survives a restart of the app", async () => {
    replies[A.host] = [OK];
    await doors.doorRequest(GET);
    const kept = store.get("neoxify.doors");
    expect(kept).toBeDefined();
    // A new run: nothing in memory, and the device's storage as it was.
    doors.resetServerDoorsForTests({ now: () => now });
    store.set("neoxify.doors", kept ?? "");
    expect(doors.askDoorsFirst()).toBe(true);
    // And without it, nothing.
    doors.resetServerDoorsForTests({ now: () => now });
    expect(doors.askDoorsFirst()).toBe(false);
  });

  it("a name answering ends it, and an answer to a call made before does not start it again", async () => {
    replies[A.host] = [OK];
    await doors.doorRequest(GET);
    doors.noteNameAnswered();
    expect(doors.askDoorsFirst()).toBe(false);

    // A call that was out while a name answered.
    let release: (answer: RelayAnswer) => void = () => undefined;
    replies[A.host] = [() => new Promise<RelayAnswer>((resolve) => (release = resolve))];
    const out = doors.doorRequest(GET);
    await vi.waitFor(() => expect(sent.length).toBe(2));
    doors.noteNameAnswered();
    release(OK);
    expect((await out).kind).toBe("answered");
    expect(doors.askDoorsFirst()).toBe(false);
  });

  it("a tunnel, or a connect under way, ends it", async () => {
    replies[A.host] = [OK];
    await doors.doorRequest(GET);
    ladderPass.running.current = true;
    ladderPass.startedAt.current = Date.now();
    expect(doors.askDoorsFirst()).toBe(false);
    ladderPass.running.current = false;
    expect(doors.askDoorsFirst()).toBe(true);
    tunnelUp = true;
    await doors.noteTunnelForDoors();
    tunnelUp = false;
    expect(doors.askDoorsFirst()).toBe(false);
  });

  it("the names are due to be asked again every three minutes while it lasts", async () => {
    expect(doors.namesProbeDue()).toBe(false);
    replies[A.host] = [OK];
    await doors.doorRequest(GET);
    // They have just failed: not yet.
    expect(doors.namesProbeDue()).toBe(false);
    now += doors.NAMES_PROBE_MS;
    expect(doors.namesProbeDue()).toBe(true);
    expect(doors.namesProbeDue()).toBe(false);
    now += doors.NAMES_PROBE_MS;
    expect(doors.namesProbeDue()).toBe(true);
  });

  it("is not started by a 401, 403 or 404, which a server that is not the backend gives to everything", async () => {
    for (const status of [401, 403, 404]) {
      replies[A.host] = [json(status, { message: "no" })];
      const outcome = await doors.doorRequest(GET);
      // Handed back: it is usually the backend saying a token expired.
      expect(outcome).toEqual({ kind: "answered", answer: json(status, { message: "no" }), door: keyOf(A) });
      expect(doors.askDoorsFirst(), String(status)).toBe(false);
    }
    // An answer that does show the backend starts it.
    replies[A.host] = [OK];
    await doors.doorRequest(GET);
    expect(doors.askDoorsFirst()).toBe(true);
  });

  it("a write that went out and got no answer does not set the doors aside", async () => {
    replies[A.host] = ["door: timeout"];
    expect(await doors.doorRequest(WRITE)).toEqual({ kind: "unanswered", spent: true });
    // The door took the connection: the network is not the trouble. The
    // next call is not skipped, and goes to another door.
    replies[B.host] = [OK];
    sent = [];
    expect((await doors.doorRequest(GET)).kind).toBe("answered");
    expect(asked()).toEqual([B.host]);
  });

  it("two calls in a row that no door answers end it", async () => {
    replies[A.host] = [OK];
    await doors.doorRequest(GET);
    expect((await doors.doorRequest(GET)).kind).toBe("unanswered");
    expect(doors.askDoorsFirst()).toBe(true);
    expect((await doors.doorRequest(GET)).kind).toBe("unanswered");
    expect(doors.askDoorsFirst()).toBe(false);
  });

  it("doors that all just failed are left alone there for two minutes", async () => {
    expect((await doors.doorRequest(GET)).kind).toBe("unanswered");
    expect(sent.length).toBe(3);
    // The next request does not pay for them again.
    expect(await doors.doorRequest(GET)).toEqual({ kind: "skipped" });
    expect(sent.length).toBe(3);
    // Another network has not been asked.
    network = "asn:64501";
    replies[D.host] = [OK];
    expect((await doors.doorRequest(GET)).kind).toBe("answered");
    network = "asn:64500";
    now += doors.DOOR_REST_MS;
    sent = [];
    replies[D.host] = [OK];
    expect((await doors.doorRequest(GET)).kind).toBe("answered");
    // The one not asked before goes first; the three that failed follow.
    expect(asked()).toEqual([D.host]);
  });

  it("and for twice as long each time they fail there again, until one answers", async () => {
    const failsAndRestsFor = async () => {
      expect((await doors.doorRequest(GET)).kind).toBe("unanswered");
      const from = now;
      for (;;) {
        now += 60_000;
        sent = [];
        const outcome = await doors.doorRequest(GET);
        if (outcome.kind !== "skipped") return now - from;
      }
    };
    // Each call of the helper is two failures: the one that starts the
    // rest, and the one that ends the wait for it.
    expect(await failsAndRestsFor()).toBe(doors.DOOR_REST_MS);
    now += 4 * 60_000;
    expect(await failsAndRestsFor()).toBe(4 * doors.DOOR_REST_MS);
    now += doors.DOOR_REST_MAX_MS;
    expect(await failsAndRestsFor()).toBe(doors.DOOR_REST_MAX_MS);
    // An answer puts it back to the first.
    now += doors.DOOR_REST_MAX_MS;
    replies[A.host] = [OK];
    expect((await doors.doorRequest(GET)).kind).toBe("answered");
    doors.noteNameAnswered();
    now += doors.DOOR_MODE_MS;
    expect(await failsAndRestsFor()).toBe(doors.DOOR_REST_MS);
  });

  it("calls that fail together ask the doors one at a time, and the rest go to the one that answered", async () => {
    replies[B.host] = [OK, OK, OK];
    const all = await Promise.all([doors.doorRequest(GET), doors.doorRequest(GET), doors.doorRequest(GET)]);
    expect(all.map((o) => o.kind)).toEqual(["answered", "answered", "answered"]);
    // A was asked once, by the first; the others went straight to B.
    expect(asked()).toEqual([A.host, B.host, B.host, B.host]);
  });
});

describe("a question about one door", () => {
  it("is asked of that door alone, even while the doors are being left alone", async () => {
    expect((await doors.doorRequest(GET)).kind).toBe("unanswered");
    expect(await doors.doorRequest(GET)).toEqual({ kind: "skipped" });
    sent = [];
    replies[C.host] = [OK];
    const health = { method: "GET", path: "/health", only: keyOf(C) };
    expect(await doors.doorRequest(health)).toEqual({ kind: "answered", answer: OK, door: keyOf(C) });
    expect(asked()).toEqual([C.host]);
    // No other door is asked in its place.
    sent = [];
    expect(await doors.doorRequest(health)).toEqual({ kind: "unanswered", spent: false });
    expect(asked()).toEqual([C.host]);
    expect(await doors.doorRequest({ ...health, only: "192.0.2.99:1" })).toEqual({ kind: "skipped" });
  });

  it("a door shown not to be the backend goes behind the others", async () => {
    replies[A.host] = [OK];
    await doors.doorRequest(GET);
    doors.noteDoorNotBackend(keyOf(A));
    replies[B.host] = [OK];
    sent = [];
    await doors.doorRequest(GET);
    expect(asked()).toEqual([B.host]);
  });
});

describe("a caller's own deadline", () => {
  it("that has passed sends nothing", async () => {
    const deadline = new AbortController();
    deadline.abort();
    expect(await doors.doorRequest({ ...GET, signal: deadline.signal })).toEqual({ kind: "skipped" });
    expect(sent).toEqual([]);
  });

  it("that passes while a door is asked ends the call, and holds nothing against the door", async () => {
    const deadline = new AbortController();
    replies[A.host] = [() => new Promise<RelayAnswer>(() => undefined), OK];
    const trace = newTrace();
    const read = doors.doorRequest({ ...GET, signal: deadline.signal }, trace);
    await vi.waitFor(() => expect(sent.length).toBe(1));
    deadline.abort();
    expect(await read).toEqual({ kind: "unanswered", spent: false });
    expect(renderTrace(trace, now + 250)).toBe("door: 192.0.2.10:2053=budget@250");
    // Not resting, and A still leads.
    sent = [];
    expect((await doors.doorRequest(GET)).kind).toBe("answered");
    expect(asked()).toEqual([A.host]);
  });

  it("that passes while a write is out leaves the write spent", async () => {
    const deadline = new AbortController();
    replies[A.host] = [() => new Promise<RelayAnswer>(() => undefined)];
    const write = doors.doorRequest({ ...WRITE, signal: deadline.signal });
    await vi.waitFor(() => expect(sent.length).toBe(1));
    deadline.abort();
    expect(await write).toEqual({ kind: "unanswered", spent: true });
  });
});
