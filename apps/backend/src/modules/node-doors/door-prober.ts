import { Injectable } from "@nestjs/common";
import { X509Certificate } from "node:crypto";
import type { ClientRequest } from "node:http";
import { request, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { certificateIsOurs, spkiPin } from "./door";

/** One port of one node, asked whether it is a door. */
export interface DoorTarget {
  /** The node's public address. */
  address: string;
  port: number;
  /** The server name to send, or null for none. */
  sni: string | null;
  /** Host names the database records for this node (`knownNames`). */
  names: string[];
  /** Domains of ours (`doorDomains`). */
  domains: string[];
}

export type DoorProbe = { ok: true; pin: string } | { ok: false; reason: string };

export interface ProbeOptions {
  /** The roots a chain must end at. Only tests set it, to a root of their
   * own; left out, it is the public CAs Node ships with. */
  ca?: string | string[];
  timeoutMs?: number;
  now?: () => number;
}

/** The whole check on one port, start to finish. A node that is down
 * costs this once per port tried. */
const PROBE_TIMEOUT_MS = 6_000;

/** The call made through the door: the API's own health check, which
 * answers `{ status: "ok", timestamp }` once it has reached the database.
 * Under /api because that is where a node's mirror is. */
const CHECK_PATH = "/api/health";

/** How far the answer's timestamp may be from now. The answer comes from
 * this same backend by way of the node, so this is not about clocks: it
 * says the answer was made for this request and not kept from another. */
const ANSWER_SLACK_MS = 2 * 60_000;

const MAX_ANSWER_BYTES = 4_096;

/** Whether `body` is the API's health answer, made just now. */
export function isHealthAnswer(status: number, body: string, now: number): boolean {
  if (status !== 200) return false;
  try {
    const answer = JSON.parse(body) as {
      status?: unknown;
      timestamp?: unknown;
    };
    if (answer?.status !== "ok" || typeof answer.timestamp !== "string") return false;
    return Math.abs(Date.parse(answer.timestamp) - now) <= ANSWER_SLACK_MS;
  } catch {
    return false;
  }
}

/** Connects to one port of a node the way a client will -- its address,
 * the given server name or none, no name of ours on the wire -- and says
 * whether it is a door, and under which key.
 *
 * It is one only if all of this holds:
 *
 * * the certificate chains to a public CA and is within its dates. That
 *   is Node's own verification, against the roots it ships with, and it
 *   is never turned off here;
 * * the certificate names a host of ours (`certificateIsOurs`). Checked
 *   in place of the usual comparison with the name dialled, which here is
 *   an address or somebody else's name on purpose. The request is not
 *   sent to anything that fails it;
 * * the API's health check answers through it, so the pin is of a port
 *   that really carries the API and not just of a node's certificate.
 *
 * The pin is taken from the certificate that passed, in the same
 * handshake. Never throws, and never takes longer than its timeout. */
export function probeDoor(target: DoorTarget, options: ProbeOptions = {}): Promise<DoorProbe> {
  const now = options.now ?? Date.now;
  return new Promise((resolve) => {
    let pin: string | null = null;
    let settled = false;
    let req: ClientRequest | undefined;
    const finish = (result: DoorProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req?.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), options.timeoutMs ?? PROBE_TIMEOUT_MS);

    try {
      const ask: RequestOptions & { ALPNProtocols: string[] } = {
        host: target.address,
        port: target.port,
        method: "GET",
        path: CHECK_PATH,
        // The empty string sends no server name. Left undefined, Node
        // would take one from the Host header.
        servername: target.sni ?? "",
        headers: {
          Host: target.sni ?? (isIP(target.address) === 6 ? `[${target.address}]` : target.address),
          Accept: "application/json",
          Connection: "close",
        },
        // A connection of its own, closed after: nothing is kept open
        // to a node between checks.
        agent: false,
        // A TLS inbound hands an HTTP/1.1 hello to the mirror's
        // HTTP/1.1 socket; without this it is offered nothing to
        // choose by.
        ALPNProtocols: ["http/1.1"],
        rejectUnauthorized: true,
        ca: options.ca,
        checkServerIdentity: (_dialled, peer) => {
          try {
            const cert = new X509Certificate(peer.raw);
            if (!certificateIsOurs(cert, target.names, target.domains)) {
              return new Error("the certificate names no host of ours");
            }
            pin = spkiPin(cert);
            return undefined;
          } catch (err) {
            return err as Error;
          }
        },
      };
      req = request(ask, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ANSWER_BYTES) finish({ ok: false, reason: "api: the answer is too long" });
          else chunks.push(chunk);
        });
        res.on("error", (err) => finish({ ok: false, reason: `api: ${err.message}` }));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (pin === null) finish({ ok: false, reason: "no certificate was checked" });
          else if (!isHealthAnswer(status, Buffer.concat(chunks).toString("utf8"), now())) {
            finish({
              ok: false,
              reason: `api: status ${status} is not the health check's answer`,
            });
          } else finish({ ok: true, pin });
        });
      });
      req.on("error", (err: NodeJS.ErrnoException) =>
        finish({
          ok: false,
          reason: err.code ? `${err.code}: ${err.message}` : err.message,
        }),
      );
      req.end();
    } catch (err) {
      finish({ ok: false, reason: (err as Error).message });
    }
  });
}

/** `probeDoor` as something the learner is given, so its tests can stand
 * in for the network. */
@Injectable()
export class DoorProber {
  probe(target: DoorTarget): Promise<DoorProbe> {
    return probeDoor(target);
  }
}
