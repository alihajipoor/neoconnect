import { ConfigService } from "@nestjs/config";
import { HealthController } from "./health.controller";
import type { PrismaService } from "../../prisma/prisma.service";
import type { Request, Response } from "express";
import { Readable, Writable } from "node:stream";
import {
  BULK_CHUNK_BYTES,
  BULK_IN_FLIGHT,
  BULK_MAX_BYTES,
  BULK_TIMED_MAX_BYTES,
  BULK_WINDOW_MAX_MS,
  BULK_WINDOW_MIN_MS,
  bulkWindow,
  streamBulk,
} from "./data-check";
import { AsnLookupService } from "../network-identity/asn-lookup.service";
import { AsnTable } from "../network-identity/asn-table";
import { NetworkIdentityService } from "../network-identity/network-identity.service";
import { networkAttestor } from "../network-identity/network-attestation";

const SECRET = "test-secret-not-a-real-one";

/** A controller over a small ASN table: 198.51.100.0/24 is a customer
 * ISP, 203.0.113.0/24 a hosting provider with one of our nodes on
 * 203.0.113.20 (all RFC 5737 documentation ranges), and 104.28.0.0/16
 * is Cloudflare's WARP egress -- in Cloudflare's AS, not on its list of
 * proxy edges. */
function build(nodes: Array<{ publicIp: string; mirrorHost: string | null }> = []) {
  const config = new ConfigService({ security: { exitHandleSecret: SECRET }, asn: { enabled: false } });
  const lookup = new AsnLookupService(config);
  lookup.use(
    AsnTable.fromLines([
      "104.28.0.0\t104.28.255.255\t13335\tUS\tCLOUDFLARENET",
      "198.51.100.0\t198.51.100.255\t64500\tIR\tEXAMPLE-ISP Example Carrier",
      "203.0.113.0\t203.0.113.255\t64501\tDE\tEXAMPLE-HOST Example Hosting",
    ]),
  );
  const prisma = { node: { findMany: jest.fn().mockResolvedValue(nodes) } } as unknown as PrismaService;
  const identity = new NetworkIdentityService(prisma, lookup, config);
  return new HealthController(prisma, identity);
}

/** The client compares this value before and after connecting to prove
 * its traffic actually moved. Returning a proxy's address instead of the
 * caller's makes both readings identical, which the app correctly reads
 * as "the tunnel is carrying nothing" -- reporting every working
 * connection as unprotected. */
describe("HealthController.ip", () => {
  const controller = build();
  const ask = async (headers: Record<string, string>, socketIp = "10.0.0.1") =>
    (await controller.ip(socketIp, { headers } as unknown as Request)).ip;

  it("returns the socket address when nothing is proxying", async () => {
    expect(await ask({})).toBe("10.0.0.1");
  });

  /** Measured against production: through the CDN this returned
   * 162.158.41.5 while the caller was 50.47.175.127. */
  it("prefers Cloudflare's header over the hop it arrived from", async () => {
    expect(
      await ask({
        "cf-connecting-ip": "50.47.175.127",
        "x-forwarded-for": "50.47.175.127, 162.158.41.5",
        "x-real-ip": "162.158.41.5",
      }),
    ).toBe("50.47.175.127");
  });

  /** A node's API mirror adds a hop, so the chain grows on the right.
   * The client stays leftmost. */
  it("takes the client end of a forwarded chain, not the last proxy", async () => {
    expect(
      await ask({ "x-forwarded-for": "50.47.175.127, 204.168.161.100", "x-real-ip": "204.168.161.100" }),
    ).toBe("50.47.175.127");
  });

  /** X-Real-IP is the immediate peer, which is only the client when
   * nothing else forwarded the request. */
  it("falls back to X-Real-IP when there is no forwarded chain", async () => {
    expect(await ask({ "x-real-ip": "50.47.175.127" })).toBe("50.47.175.127");
  });
});

/** A Cloudflare edge, as nginx sees it for a request through the CDN --
 * the address measured in production on 2026-08-04. */
const EDGE = "162.158.41.5";

/** The pre-connect baseline is the one moment the server sees the
 * customer's own address, so it is where their network is read. These
 * arrive through the CDN, the ordinary path. */
describe("HealthController.ip network", () => {
  const from = (ip: string) => ({ headers: { "cf-connecting-ip": ip } }) as unknown as Request;

  it("names the caller's network and signs it", async () => {
    const answer = await build().ip(EDGE, from("198.51.100.7"));
    expect(answer).toMatchObject({ asn: 64500, asnOrg: "EXAMPLE-ISP Example Carrier" });
    // The token has to round-trip: it is what reports carry back.
    expect(networkAttestor(SECRET).verify((answer as { network?: string }).network)).toBe(64500);
  });

  /** The after-connect egress check asks from the node. Believed, that
   * would file every success through a node under the node's own data
   * centre -- which would then "work well" by construction. */
  it("says nothing about the network when the caller is one of our nodes", async () => {
    const answer = await build([{ publicIp: "203.0.113.20", mirrorHost: null }]).ip(EDGE, from("203.0.113.20"));
    expect(answer).toEqual({ ip: "203.0.113.20", country: undefined });
  });

  /** Exact addresses, not whole networks: a neighbour of a node in the
   * same ASN is still a customer. */
  it("still names the network of an address next to a node", async () => {
    const answer = await build([{ publicIp: "203.0.113.20", mirrorHost: null }]).ip(EDGE, from("203.0.113.21"));
    expect(answer).toMatchObject({ asn: 64501 });
  });

  /** Not knowing which addresses are ours is not a reason to believe
   * none are. */
  it("fails closed when the node list cannot be read", async () => {
    const config = new ConfigService({ security: { exitHandleSecret: SECRET }, asn: { enabled: false } });
    const lookup = new AsnLookupService(config);
    lookup.use(AsnTable.fromLines(["198.51.100.0\t198.51.100.255\t64500\tIR\tEXAMPLE-ISP"]));
    const prisma = { node: { findMany: jest.fn().mockRejectedValue(new Error("db down")) } } as unknown as PrismaService;
    const controller = new HealthController(prisma, new NetworkIdentityService(prisma, lookup, config));
    const answer = await controller.ip(EDGE, from("198.51.100.7"));
    expect(answer).not.toHaveProperty("asn");
  });

  /** The names that reach the origin directly carry no CF-IPCountry, which
   * left the relay of last resort with no evidence on them. */
  it("gives the network's registered country when the CDN gave none", async () => {
    const answer = await build().ip(EDGE, from("198.51.100.7"));
    expect(answer).toMatchObject({ country: "IR", asn: 64500 });
    expect(answer).not.toHaveProperty("region");
  });

  it("prefers the CDN's country over the registered one", async () => {
    const req = { headers: { "cf-connecting-ip": "198.51.100.7", "cf-ipcountry": "tr" } } as unknown as Request;
    expect(await build().ip(EDGE, req)).toMatchObject({ country: "TR" });
  });

  /** A baseline answered through another VPN would name that VPN's
   * exit, and a non-Iranian stamp outranks an Iranian one in the relay's
   * evidence. Only "IR" is ever filled in from the table. */
  it("gives no registered country other than Iran", async () => {
    const answer = await build().ip(EDGE, from("203.0.113.30"));
    expect(answer).toMatchObject({ asn: 64501, country: undefined });
  });

  /** WARP users egress in Cloudflare's AS, registered in the US. */
  it("gives no registered country for Cloudflare's own network", async () => {
    const answer = await build().ip(EDGE, from("104.28.1.1"));
    expect(answer).toMatchObject({ asn: 13335, country: undefined });
  });

  it("answers the address alone while no table is loaded", async () => {
    const config = new ConfigService({ asn: { enabled: false } });
    const prisma = { node: { findMany: jest.fn().mockResolvedValue([]) } } as unknown as PrismaService;
    const lookup = new AsnLookupService(config);
    const controller = new HealthController(prisma, new NetworkIdentityService(prisma, lookup, config));
    expect(await controller.ip(EDGE, from("198.51.100.7"))).toEqual({ ip: "198.51.100.7", country: undefined });
  });
});

/** The token goes into everyone's per-ISP tags, so it is signed only for
 * an address the caller could not have chosen. The origin answers on 443
 * directly, where CF-Connecting-IP and X-Forwarded-For are whatever the
 * caller sent. */
describe("HealthController.ip attestation", () => {
  const token = (answer: object) => (answer as { network?: string }).network;
  const req = (headers: Record<string, string>) => ({ headers }) as unknown as Request;

  it("signs the network of a direct caller's own address", async () => {
    const answer = await build().ip("198.51.100.7", req({}));
    expect(networkAttestor(SECRET).verify(token(answer))).toBe(64500);
  });

  it("signs the network Cloudflare names, when the request came from Cloudflare", async () => {
    const answer = await build().ip(EDGE, req({ "cf-connecting-ip": "198.51.100.7" }));
    expect(networkAttestor(SECRET).verify(token(answer))).toBe(64500);
  });

  /** Before: a valid token for the carrier, which five accounts could
   * then use to tell everyone on it that working routes fail. */
  it("does not sign a carrier a direct caller only claims in CF-Connecting-IP", async () => {
    const answer = await build().ip("192.0.2.50", req({ "cf-connecting-ip": "198.51.100.7" }));
    // The echo is the caller's own business; the signature is not.
    expect(answer).toMatchObject({ ip: "198.51.100.7", asn: 64500 });
    expect(token(answer)).toBeUndefined();
  });

  it("does not sign a carrier a caller writes into X-Forwarded-For", async () => {
    const answer = await build().ip("203.0.113.99", req({ "x-forwarded-for": "198.51.100.7, 203.0.113.99" }));
    expect(answer).toMatchObject({ ip: "198.51.100.7", asn: 64500 });
    expect(token(answer)).toBeUndefined();
  });

  /** The cost, stated: through a node's mirror pointed at the origin the
   * peer is the node. Its left neighbour is the real client there, but
   * the same shape arrives from a customer's own tunnel with a forged
   * entry, so neither is signed. */
  it("does not sign through a node, whatever its forwarded chain says", async () => {
    const answer = await build([{ publicIp: "203.0.113.20", mirrorHost: null }]).ip(
      "203.0.113.20",
      req({ "x-forwarded-for": "198.51.100.7, 203.0.113.20" }),
    );
    expect(answer).toMatchObject({ ip: "198.51.100.7", asn: 64500 });
    expect(token(answer)).toBeUndefined();
  });

  /** WARP egress is in Cloudflare's AS but not on its proxy list, so its
   * header is not believed -- and its own network is not a carrier. */
  it("never signs Cloudflare's own network", async () => {
    const answer = await build().ip("104.28.1.1", req({ "cf-connecting-ip": "198.51.100.7" }));
    expect(token(answer)).toBeUndefined();
    const direct = await build().ip("104.28.1.1", req({}));
    expect(direct).toMatchObject({ asn: 13335 });
    expect(token(direct)).toBeUndefined();
  });
});

/** The apps' check that a tunnel moves data, not only that its address
 * changed (data-check.ts). */
describe("HealthController bulk", () => {
  /** Enough of an Express response to see what was answered. */
  function response() {
    const sent: { status?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
    const listeners: Array<() => void> = [];
    const res = {
      headersSent: false,
      status(code: number) {
        sent.status = code;
        return res;
      },
      set(name: string | Record<string, string>, value?: string) {
        if (typeof name === "string") sent.headers[name] = value ?? "";
        else Object.assign(sent.headers, name);
        return res;
      },
      json(body: unknown) {
        sent.body = body;
        return res;
      },
      end(body?: unknown) {
        sent.body = body;
        return res;
      },
      once(_event: string, listener: () => void) {
        listeners.push(listener);
        return res;
      },
    };
    return { res: res as unknown as Response, sent, close: () => listeners.forEach((l) => l()) };
  }

  it("serves the bytes asked for, uncached and uncompressed", () => {
    const { res, sent } = response();
    build().bulkDown("262144", undefined, res);
    expect(sent.status).toBe(200);
    expect((sent.body as Buffer).length).toBe(262_144);
    expect(sent.headers["Content-Length"]).toBe("262144");
    expect(sent.headers["Cache-Control"]).toContain("no-store");
    expect(sent.headers["Cache-Control"]).toContain("no-transform");
    expect(sent.headers["Content-Type"]).toBe("application/octet-stream");
  });

  it.each([undefined, "", "0", "-1", "1e5", "524289", "abc"])("refuses %p bytes", (raw) => {
    const { res, sent } = response();
    build().bulkDown(raw, undefined, res);
    expect(sent.status).toBe(400);
  });

  /** A response that takes what is written at a pace of its own: a real
   * Writable, so backpressure, `drain`, `close` and `writableEnded` are
   * the stream's rather than a stand-in's. `perChunkMs` is how long the
   * sink takes over each chunk -- a slow tunnel. */
  function timedResponse(perChunkMs = 0) {
    const sent: { status?: number; body?: unknown; headers: Record<string, string>; bytes: number } = { headers: {}, bytes: 0 };
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        sent.bytes += chunk.length;
        // Infinity: a sink that never takes the chunk -- a client that
        // opened the request and never reads.
        if (perChunkMs === 0) done();
        else if (Number.isFinite(perChunkMs)) setTimeout(done, perChunkMs);
      },
    });
    const res = Object.assign(stream, {
      status(code: number) {
        sent.status = code;
        return res;
      },
      set(name: string | Record<string, string>, value?: string) {
        if (typeof name === "string") sent.headers[name] = value ?? "";
        else Object.assign(sent.headers, name);
        return res;
      },
      json(body: unknown) {
        sent.body = body;
        stream.end();
        return res;
      },
    });
    const finished = new Promise<void>((resolve) => stream.once("finish", resolve));
    return { res: res as unknown as Response, sent, finished, destroy: () => stream.destroy() };
  }

  /** The apps' sample of a landed tunnel's speed: for the window asked,
   * paced by what the connection takes, with no length announced. */
  it("streams for the window asked, at the pace the response takes it", async () => {
    const { res, sent, finished } = timedResponse(20);
    const started = Date.now();
    build().bulkDown("524288", "300", res);
    await finished;
    const took = Date.now() - started;
    expect(sent.status).toBe(200);
    expect(sent.headers["Content-Length"]).toBeUndefined();
    expect(sent.headers["X-Accel-Buffering"]).toBe("no");
    expect(sent.headers["Cache-Control"]).toContain("no-transform");
    // About 300 ms of 64 KiB every 20 ms, give or take the timer; never
    // the whole cap, which an unpaced write would have reached at once.
    expect(sent.bytes).toBeGreaterThanOrEqual(5 * BULK_CHUNK_BYTES);
    expect(sent.bytes).toBeLessThan(BULK_TIMED_MAX_BYTES / 2);
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(1_500);
  });

  it("sends no more than the cap, however long the window", async () => {
    const { res, sent } = timedResponse();
    const written = await streamBulk(res, Date.now() + 10_000, { maxBytes: 3 * BULK_CHUNK_BYTES });
    expect(written).toBe(3 * BULK_CHUNK_BYTES);
    expect(sent.bytes).toBe(3 * BULK_CHUNK_BYTES);
    expect(res.writableEnded).toBe(true);
  });

  /** The app stops reading at its own deadline; the drain it was waiting
   * for never comes, and the stream must not wait out the window for it. */
  it("stops when the response closes under it", async () => {
    const { res, sent, destroy } = timedResponse(20);
    const started = Date.now();
    const writing = streamBulk(res, Date.now() + 2_000);
    setTimeout(destroy, 60);
    await writing;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(sent.bytes).toBeLessThan(BULK_TIMED_MAX_BYTES / 4);
  });

  /** A client that opens the request and never reads: the response's end
   * waits on a socket that never drains, and the in-flight slot with it,
   * for as long as nginx allows the socket. Cut after the grace instead,
   * so the slot is bounded by the window and the grace, not the client. */
  it("cuts a response nobody reads once the window and the grace are up", async () => {
    const { res, sent } = timedResponse(Infinity);
    const closed = new Promise<void>((resolve) => res.once("close", resolve));
    const started = Date.now();
    const written = await streamBulk(res, Date.now() + 100, { endGraceMs: 100 });
    expect(written).toBe(BULK_CHUNK_BYTES);
    expect(sent.bytes).toBe(BULK_CHUNK_BYTES);
    expect(res.writableEnded).toBe(true);
    expect(res.writableFinished).toBe(false);
    await closed;
    expect(res.destroyed).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("clamps the window to its bounds and refuses one that is not a number", () => {
    expect(bulkWindow(undefined)).toBeUndefined();
    expect(bulkWindow("10")).toBe(BULK_WINDOW_MIN_MS);
    expect(bulkWindow("1500")).toBe(1_500);
    expect(bulkWindow("999999")).toBe(BULK_WINDOW_MAX_MS);
    for (const raw of ["", "abc", "-1", "1.5"]) expect(bulkWindow(raw)).toBeNull();
    const { res, sent } = response();
    build().bulkDown("1024", "abc", res);
    expect(sent.status).toBe(400);
  });

  it("counts what is uploaded and keeps none of it", async () => {
    const { res, sent } = response();
    const body = Readable.from([Buffer.alloc(100_000), Buffer.alloc(156_144)]);
    await build().bulkUp(body as unknown as Request, res);
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ received: 256_144 });
  });

  it("stops reading past the limit", async () => {
    const { res, sent } = response();
    const body = Readable.from([Buffer.alloc(BULK_MAX_BYTES), Buffer.alloc(1)]);
    await build().bulkUp(body as unknown as Request, res);
    expect(sent.status).toBe(413);
  });

  /** Unauthenticated, so a burst is turned away rather than queued; the
   * apps read 503 as "could not measure", never as a slow tunnel. */
  it("turns away transfers beyond the limit in flight, and frees the slot when one ends", () => {
    const controller = build();
    const open = Array.from({ length: BULK_IN_FLIGHT }, () => response());
    for (const { res } of open) controller.bulkDown("1024", undefined, res);
    const over = response();
    controller.bulkDown("1024", undefined, over.res);
    expect(over.sent.status).toBe(503);
    open[0].close();
    const after = response();
    controller.bulkDown("1024", undefined, after.res);
    expect(after.sent.status).toBe(200);
  });
});
