import { X509Certificate } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { createServer as createTcpServer, type AddressInfo, type Server, type Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { leaf, testRoot, type Authority, type Leaf } from "../../../test/door-certs";
import { spkiPin } from "./door";
import { isHealthAnswer, probeDoor, type DoorTarget } from "./door-prober";

/** Real TLS on the loopback: a server standing in for one port of a node,
 * and the prober asked about it. The spec's own root stands in for the
 * public CAs, passed as the roots to trust -- except in the one test that
 * leaves it out, to show the default trusts nothing of the kind. */

const OURS = "fi1.example.test";
const NEUTRAL = "static.example.com";
const DAY_MS = 24 * 60 * 60_000;

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const healthy: Handler = (_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
};

interface Running {
  port: number;
  /** What each TLS hello carried: the server name (false for none) and
   * the protocol agreed. */
  hellos: { sni: string | false; alpn: string | false }[];
  /** Each request that got as far as HTTP. */
  requests: { path: string; host: string | undefined }[];
}

const open: Server[] = [];

async function listening(server: Server): Promise<number> {
  open.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function serve(certificate: Leaf, handler: Handler = healthy): Promise<Running> {
  const running: Running = { port: 0, hellos: [], requests: [] };
  const server = createTlsServer(
    // Offers HTTP/2 first, as a node's TLS inbound does.
    { key: certificate.keyPem, cert: certificate.certPem, ALPNProtocols: ["h2", "http/1.1"] },
    (req, res) => {
      running.requests.push({ path: req.url ?? "", host: req.headers.host });
      handler(req, res);
    },
  );
  server.on("secureConnection", (socket: TLSSocket & { servername?: string | false }) => {
    running.hellos.push({ sni: socket.servername ?? false, alpn: socket.alpnProtocol ?? false });
  });
  running.port = await listening(server);
  return running;
}

afterAll(async () => {
  await Promise.all(
    open.map(
      (server) =>
        new Promise<void>((resolve) => {
          (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("asking one port of a node whether it is a door", () => {
  let root: Authority;
  let good: Leaf;

  const target = (port: number, over: Partial<DoorTarget> = {}): DoorTarget => ({
    address: "127.0.0.1",
    port,
    sni: NEUTRAL,
    names: [OURS],
    domains: [],
    ...over,
  });
  const ask = (port: number, over: Partial<DoorTarget> = {}) => probeDoor(target(port, over), { ca: root.certPem });

  beforeAll(() => {
    root = testRoot();
    good = leaf({ names: [OURS], by: root });
  });

  it("takes a certificate a trusted CA issued for a name of ours, with the API behind it", async () => {
    const node = await serve(good);
    expect(await ask(node.port)).toEqual({ ok: true, pin: spkiPin(new X509Certificate(good.certPem)) });
    // Reached as a client will reach it: the neutral name in the hello,
    // never ours, HTTP/1.1, and the API's health check under /api.
    expect(node.hellos).toEqual([{ sni: NEUTRAL, alpn: "http/1.1" }]);
    expect(node.requests).toEqual([{ path: "/api/health", host: NEUTRAL }]);
  });

  it("sends no server name at all when the door has none", async () => {
    const node = await serve(good);
    expect(await ask(node.port, { sni: null })).toMatchObject({ ok: true });
    expect(node.hellos).toEqual([{ sni: false, alpn: "http/1.1" }]);
    expect(node.requests).toEqual([{ path: "/api/health", host: "127.0.0.1" }]);
  });

  it("takes a certificate under one of our domains", async () => {
    const node = await serve(leaf({ names: ["d7.direct.example.org"], by: root }));
    expect(await ask(node.port, { names: [], domains: ["example.org"] })).toMatchObject({ ok: true });
  });

  it("refuses a self-signed certificate, whatever it names", async () => {
    const node = await serve(leaf({ names: [OURS] }));
    expect(await ask(node.port)).toEqual({ ok: false, reason: expect.stringContaining("SELF_SIGNED") });
    expect(node.requests).toEqual([]);
  });

  it("refuses a certificate from a CA that is not trusted", async () => {
    const node = await serve(leaf({ names: [OURS], by: testRoot("Some other root") }));
    expect(await ask(node.port)).toEqual({ ok: false, reason: expect.stringMatching(/UNABLE_TO_(VERIFY|GET_ISSUER)/) });
    expect(node.requests).toEqual([]);
  });

  it("trusts only the public CAs unless told otherwise", async () => {
    // The same server that passes above, asked without the spec's root.
    const node = await serve(good);
    expect(await probeDoor(target(node.port))).toEqual({
      ok: false,
      reason: expect.stringMatching(/UNABLE_TO_(VERIFY|GET_ISSUER)/),
    });
    expect(node.requests).toEqual([]);
  });

  it("refuses a properly issued certificate for somebody else's name, and sends it nothing", async () => {
    const node = await serve(leaf({ names: ["www.example.com", NEUTRAL], by: root }));
    expect(await ask(node.port)).toEqual({ ok: false, reason: expect.stringContaining("names no host of ours") });
    expect(node.requests).toEqual([]);
  });

  it("refuses an expired certificate", async () => {
    const expired = leaf({
      names: [OURS],
      by: root,
      notBefore: new Date(Date.now() - 20 * DAY_MS),
      notAfter: new Date(Date.now() - DAY_MS),
    });
    const node = await serve(expired);
    expect(await ask(node.port)).toEqual({ ok: false, reason: expect.stringContaining("CERT_HAS_EXPIRED") });
    expect(node.requests).toEqual([]);
  });

  it("refuses a certificate that is not valid yet", async () => {
    const early = leaf({
      names: [OURS],
      by: root,
      notBefore: new Date(Date.now() + DAY_MS),
      notAfter: new Date(Date.now() + 20 * DAY_MS),
    });
    const node = await serve(early);
    expect(await ask(node.port)).toEqual({ ok: false, reason: expect.stringContaining("CERT_NOT_YET_VALID") });
    expect(node.requests).toEqual([]);
  });

  it.each<[string, Handler]>([
    [
      "a page instead of the API",
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><body>It works!</body></html>");
      },
    ],
    [
      "a mirror that cannot reach the panel",
      (_req, res) => {
        res.writeHead(502);
        res.end("Bad Gateway");
      },
    ],
    [
      "an API whose database is down",
      (_req, res) => {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "database unreachable" }));
      },
    ],
    [
      "an answer kept from another time",
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", timestamp: new Date(Date.now() - 3_600_000).toISOString() }));
      },
    ],
    [
      "an answer far too long to be the health check's",
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString(), padding: "x".repeat(64_000) }));
      },
    ],
  ])("is not a door when our certificate has %s behind it", async (_what, handler) => {
    const node = await serve(good, handler);
    expect(await ask(node.port)).toEqual({ ok: false, reason: expect.stringContaining("api:") });
    expect(node.requests).toHaveLength(1);
  });

  it("gives up on a port that accepts and then says nothing, within its timeout", async () => {
    const held: Socket[] = [];
    const port = await listening(createTcpServer((socket) => held.push(socket)));
    const started = Date.now();
    expect(await probeDoor(target(port), { ca: root.certPem, timeoutMs: 300 })).toEqual({
      ok: false,
      reason: "timeout",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    for (const socket of held) socket.destroy();
  });

  it("says a closed port is not a door, without throwing", async () => {
    const server = createTcpServer();
    const port = await listening(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probeDoor(target(port), { ca: root.certPem, timeoutMs: 4_000 })).toMatchObject({ ok: false });
  });
});

describe("the health check's answer", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const body = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ status: "ok", timestamp: new Date(now).toISOString(), ...over });

  it("is status 200, ok, and a time close to now", () => {
    expect(isHealthAnswer(200, body(), now)).toBe(true);
    expect(isHealthAnswer(200, body({ timestamp: new Date(now - 60_000).toISOString() }), now)).toBe(true);
  });

  it.each([
    ["another status", 204, body()],
    ["not ok", 200, body({ status: "error" })],
    ["no time", 200, JSON.stringify({ status: "ok" })],
    ["a time that is not one", 200, body({ timestamp: "soon" })],
    ["an old time", 200, body({ timestamp: new Date(now - 10 * 60_000).toISOString() })],
    ["not JSON", 200, "ok"],
    ["JSON that is not an object", 200, "null"],
  ])("is not %s", (_what, status, text) => {
    expect(isHealthAnswer(status, text, now)).toBe(false);
  });
});
