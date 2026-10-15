import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type RequestListener, type Server } from "node:http";
import { isIP, type Socket } from "node:net";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { relayAllows, relayNeedsIran } from "./relay-allowlist";

/** Proof that a request came through the Iranian relay
 * (docs/relay-last-resort.md, R2).
 *
 * The proof is the door it came in by, never anything it says about
 * itself. The origin's relay server block (the one that terminates the
 * pinned TLS from the box) proxies to a second listener of this backend
 * that nothing else proxies to; a request is a relay request if and only
 * if its socket was accepted by that listener. Headers a client could
 * send -- `X-Neoxify-Via`, the box name -- are removed from every request
 * on both listeners before anything reads them, and the box name is read
 * only from a relay socket, where only the origin's own block can have
 * set it.
 *
 * The second listener is published on the host's loopback only
 * (infra/docker-compose.prod.yml), but the panel and the Discord bot share
 * the backend's compose network and could dial the container's port
 * directly (F3). So it also accepts connections only from the peers that
 * stand for the host -- loopback, and the container's default gateway,
 * which is the address Docker's port publishing connects from -- and
 * closes every other connection before reading a byte. RELAY_TRUSTED_PEERS
 * overrides the detected gateway.
 */

export const VIA_HEADER = "x-neoxify-via";
export const BOX_HEADER = "x-neoxify-relay-box";

/** The refusal of a relay sign-up from a network that cannot be placed
 * (`RELAY_REGION_UNKNOWN`): not known to be outside Iran, so not told so. */
export const RELAY_REGION_UNKNOWN_MESSAGE =
  "This connection could not be confirmed as coming from inside Iran, so signing up through the backup route is not available on it right now.";

/** What the backend knows about a relay request, for the request's life. */
export interface RelayContext {
  /** The box it came through, as the origin's relay block names it, or
   * "" when it named none. */
  box: string;
  /** The caller's network, or null when unknown. */
  asn: number | null;
  /** Where that network is registered (ISO alpha-2), or null. */
  region: string | null;
  /** The caller's address, for the life of this request only. Never
   * logged, never stored, never put in a long-lived structure (I5): use
   * `ipKey` for anything that outlives the request. */
  ip: string | null;
  /** A keyed hash of the address under a key that exists only in this
   * process, for per-caller counting without holding the address. */
  ipKey: string;
}

const relaySockets = new WeakSet<Socket>();
const contexts = new WeakMap<object, RelayContext>();
const IP_KEY = randomBytes(32);

/** The relay context of a request, or null for a request that did not
 * come through the relay. */
export function relayContextOf(req: unknown): RelayContext | null {
  return req && typeof req === "object" ? (contexts.get(req) ?? null) : null;
}

/** Marks a request as a relay request. Called by relayGate, for a
 * request whose socket the relay listener accepted -- and by tests. */
export function attachRelayContext(req: object, ctx: RelayContext): void {
  contexts.set(req, ctx);
}

/** The per-process keyed hash `RelayContext.ipKey` holds. */
export function relayIpKey(ip: string | null | undefined): string {
  return `relay:${createHmac("sha256", IP_KEY)
    .update(ip ?? "")
    .digest("base64url")
    .slice(0, 22)}`;
}

/** Box names are the operator's ("ir-a", "box2"); anything else is
 * dropped rather than recorded. */
function boxName(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  const name = (raw ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(name) ? name : "";
}

export interface RelayGateDeps {
  /** The network and registered country of an address, or null. */
  lookup(ip: string): { asn: number; country: string | null } | null;
  /** Called for every request on the normal listener -- the auto
   * detector's traffic count. Must not throw. */
  observeNormal?(req: Request): void;
}

function refuse(res: Response, status: number, body: Record<string, unknown>) {
  res.status(status).setHeader("Cache-Control", "no-store");
  res.json(body);
}

/** The first middleware on every request, on both listeners. */
export function relayGate(deps: RelayGateDeps): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const box = req.headers[BOX_HEADER];
    delete req.headers[VIA_HEADER];
    delete req.headers[BOX_HEADER];

    if (!relaySockets.has(req.socket)) {
      try {
        deps.observeNormal?.(req);
      } catch {
        // Counting is never a reason to fail a request.
      }
      next();
      return;
    }

    if (!relayAllows(req.method, req.url)) {
      refuse(res, 404, { statusCode: 404, message: "Not Found" });
      return;
    }

    // With `trust proxy 1` this is the address the origin's relay block
    // put in X-Forwarded-For -- taken from the box's PROXY header, which
    // the client cannot write. A seized box can (F14); the per-network
    // and global caps are what still hold then.
    const ip = req.ip ?? null;
    const found = ip ? deps.lookup(ip) : null;
    const region = found?.country ?? null;
    if (region !== null && region !== "IR") {
      refuse(res, 403, {
        statusCode: 403,
        code: "RELAY_REGION",
        message: "The backup route is only for connections from inside Iran.",
      });
      return;
    }
    // A network the table cannot place -- an ASN it lacks, or a table not
    // loaded -- may sign in, refresh and redeem, and not sign up. Said with
    // its own code: the app switches the relay off for a day on
    // RELAY_REGION, which here would lock a caller from Iran out of the
    // sign-in this very route still allows.
    if (region === null && relayNeedsIran(req.method, req.url)) {
      refuse(res, 403, { statusCode: 403, code: "RELAY_REGION_UNKNOWN", message: RELAY_REGION_UNKNOWN_MESSAGE });
      return;
    }

    attachRelayContext(req, { box: boxName(box), asn: found?.asn ?? null, region, ip, ipKey: relayIpKey(ip) });
    next();
  };
}

function normalisePeer(address: string | undefined): string {
  const text = (address ?? "").trim().toLowerCase();
  const mapped = text.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? mapped[1] : text;
}

/** The default gateways in a Linux /proc/net/route, as dotted quads. */
export function defaultGateways(routeTable: string): string[] {
  const gateways: string[] = [];
  for (const line of routeTable.split("\n").slice(1)) {
    const [, destination, gateway] = line.trim().split(/\s+/);
    if (destination !== "00000000" || !gateway || !/^[0-9A-Fa-f]{8}$/.test(gateway)) continue;
    const value = Number.parseInt(gateway, 16);
    // Little-endian on every architecture this runs on.
    gateways.push([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24].join("."));
  }
  return gateways;
}

function readRouteTable(): string {
  try {
    return readFileSync("/proc/net/route", "utf8");
  } catch {
    return "";
  }
}

/** Who may connect to the relay listener: loopback always, plus either
 * RELAY_TRUSTED_PEERS or the default gateway. */
export function trustedRelayPeers(
  configured: string | undefined = process.env.RELAY_TRUSTED_PEERS,
  routeTable: string = readRouteTable(),
): Set<string> {
  const peers = new Set(["127.0.0.1", "::1"]);
  const extra = configured?.trim()
    ? configured.split(",").map((p) => p.trim())
    : defaultGateways(routeTable);
  for (const peer of extra) {
    const normal = normalisePeer(peer);
    if (isIP(normal)) peers.add(normal);
  }
  return peers;
}

/** RELAY_LISTEN as host and port: "0.0.0.0:4001", "127.0.0.1:4001", or a
 * bare port (loopback). Unset or malformed means no relay listener. */
export function parseRelayListen(value: string | undefined): { host: string; port: number } | null {
  const text = value?.trim();
  if (!text) return null;
  const match = text.match(/^(?:(\d{1,3}(?:\.\d{1,3}){3}):)?(\d{1,5})$/);
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  const host = match[1] ?? "127.0.0.1";
  return isIP(host) === 4 ? { host, port } : null;
}

export interface RelayListenerOptions {
  host: string;
  port: number;
  trusted: Set<string>;
  onRefused?(peer: string): void;
}

/** The second listener. Serves the same application; what makes its
 * requests relay requests is that their sockets are marked here. */
export function startRelayListener(handler: RequestListener, options: RelayListenerOptions): Promise<Server> {
  const server = createServer(handler);
  server.on("connection", (socket: Socket) => {
    const peer = normalisePeer(socket.remoteAddress);
    if (!options.trusted.has(peer)) {
      options.onRefused?.(peer);
      socket.destroy();
      return;
    }
    relaySockets.add(socket);
  });
  // Every allowed call is a small JSON exchange; nothing here should hold
  // a socket open for long.
  server.headersTimeout = 10_000;
  server.requestTimeout = 20_000;
  server.keepAliveTimeout = 5_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/** For tests: whether a request's socket was accepted by the relay listener. */
export function arrivedByRelay(req: IncomingMessage): boolean {
  return relaySockets.has(req.socket);
}
