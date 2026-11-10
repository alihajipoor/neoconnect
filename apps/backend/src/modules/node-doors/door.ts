import { createHash, X509Certificate } from "node:crypto";
import { isIP } from "node:net";

/** Every VPN server as a door to the panel API, reached by address.
 *
 * The panel API is reached by name, and names are what a filter poisons
 * or resets while the servers' own addresses stay reachable. Each node
 * already answers /api on its own address (the fallback site behind its
 * TLS inbound, and a listener of nginx's own); what a client lacks is a
 * way to trust it without the name. A door is that: the node's address,
 * the port, the pin of the key its certificate carries there, and the
 * name to send as SNI, if any.
 *
 * Nothing is configured per node and no node is changed. The backend
 * connects to each node itself (door-prober.ts), takes only a
 * certificate that a public CA issued for one of our names, checks the
 * API answers behind it, and stores what it saw on the node's row. The
 * credential list the apps already fetch and keep carries it, so a
 * replaced server replaces its door with no other step.
 *
 * This file is the rules, with no I/O: what counts as our certificate,
 * what a pin is, how a change of key is recorded, and which doors are
 * handed out. */

/** How often every node's door is checked (modules/jobs). */
export const DOOR_CYCLE_MS = 15 * 60_000;

/** A door is handed out while its last passing check is at most this old:
 * four cycles. A node that has failed four checks in a row is down, cut
 * off from the panel, or no longer presents a certificate of ours -- and
 * each of those leaves a client waiting on an address that cannot answer.
 * Short of that it stays: one missed check is a restart or a lost packet,
 * and an app replaces the list it holds with every answer, so leaving a
 * door out takes it away from the device as well. */
export const DOOR_FRESH_MS = 60 * 60_000;

/** How long the pin before a change of key is handed out beside the new
 * one. It covers a node that presents the old key again -- a second
 * listener not yet reloaded, a renewal rolled back -- and after that the
 * old key is not vouched for any more. */
export const PREVIOUS_PIN_MS = 7 * 24 * 60 * 60_000;

/** Ports tried on one node in one check, at most. */
export const MAX_CANDIDATE_PORTS = 5;

const PIN_PREFIX = "sha256/";

/** What a client is handed: everything needed to reach the API through
 * one server without a name of ours. */
export interface Door {
  /** The server's address, as the credential's own `host`. */
  host: string;
  port: number;
  /** One or two SPKI pins, the current key's first. Each is `sha256/` and
   * the standard base64 of the SHA-256 of the certificate's DER
   * SubjectPublicKeyInfo -- the relay of last resort's format. */
  pins: string[];
  /** The server name to send in the TLS hello, or null to send none. */
  sni: string | null;
}

/** The node columns a door is read from. */
export interface DoorColumns {
  publicIp: string;
  status?: string | null;
  doorPort?: number | null;
  doorSni?: string | null;
  doorPin?: string | null;
  doorPreviousPin?: string | null;
  doorPinChangedAt?: Date | null;
  doorVerifiedAt?: Date | null;
}

// ---- Settings ------------------------------------------------------
//
// Read from the environment at call time, like the device-limit switches
// (device-slots/modes.ts), so the delivery side -- a plain function in
// the credential list -- and the learner cannot disagree. Blank, as
// Compose passes an unset `${NAME:-}`, is always the default.

/** NODE_DOORS=off stops both halves at once: nothing is checked and no
 * door is handed out. Anything else, blank included, is on. */
export function nodeDoorsEnabled(): boolean {
  return (process.env.NODE_DOORS ?? "").trim().toLowerCase() !== "off";
}

/** NODE_DOOR_PORTS: ports to try on every node after the node's own TLS
 * inbounds, in order. The default is the two the installer has used: the
 * TLS inbound whose fallback is the mirror, and nginx's direct listener.
 * A list with nothing usable in it is the default, not no ports. */
export function doorPorts(raw: string | undefined = process.env.NODE_DOOR_PORTS): number[] {
  const ports = (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^\d{1,5}$/.test(part))
    .map(Number)
    .filter((port) => port >= 1 && port <= 65535);
  return ports.length > 0 ? [...new Set(ports)] : [2053, 2096];
}

/** NODE_DOOR_SNI: the server name sent to a node when checking its door,
 * recorded with the door and sent by clients in turn. Never one of ours:
 * the reason for a door is that our names are what gets filtered. The
 * default is the name the checks from inside the filtered country have
 * used against these same ports (scripts/inside-probe). "none" sends no
 * name at all. Anything that is not a host name is the default. */
export function doorSni(raw: string | undefined = process.env.NODE_DOOR_SNI): string | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "none") return null;
  return isHostName(value) ? value : "www.bing.com";
}

/** NODE_DOOR_DOMAINS: domains of ours, comma-separated. A certificate
 * naming any host under one of them is ours, beside the names the
 * database already records for the node (`knownNames`). Empty by
 * default: those names cover a node set up by the installer. */
export function doorDomains(raw: string | undefined = process.env.NODE_DOOR_DOMAINS): string[] {
  return [
    ...new Set(
      (raw ?? "")
        .split(",")
        .map((part) =>
          part
            .trim()
            .toLowerCase()
            .replace(/^\*?\./, ""),
        )
        // At least two labels: "com" would make every certificate ours.
        .filter((domain) => isHostName(domain) && domain.includes(".")),
    ),
  ];
}

function isHostName(value: string): boolean {
  if (value.length === 0 || value.length > 253 || isIP(value) !== 0) return false;
  return value.split(".").every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

// ---- What the learner asks of a node -------------------------------

/** A protocol config as the learner reads it. */
export interface DoorConfig {
  protocol: string;
  listenPort: number;
  security?: string | null;
  publicParamsJson?: unknown;
}

/** Whether a config is an inbound that presents a certificate of ours:
 * the TLS inbounds, whose fallback is the node's API mirror. Never
 * REALITY, which hands an unknown caller to the third-party site it
 * imitates -- that site's certificate is real, and is not ours. */
function presentsOurCertificate(config: DoorConfig): boolean {
  if (config.security === "REALITY" || config.protocol === "XRAY_VLESS_REALITY") return false;
  return config.security === "TLS" || config.protocol === "XRAY_VLESS_TLS" || config.protocol === "XRAY_TROJAN";
}

/** The ports to try on a node, best first: the port its door was last
 * verified on, then its own TLS inbounds from the lowest, then the
 * configured ports. So a node laid out differently from the rest is
 * found by its own configs, and a door that works is asked once. */
export function candidatePorts(node: { doorPort?: number | null }, configs: DoorConfig[], extra: number[]): number[] {
  const own = configs
    .filter(presentsOurCertificate)
    .map((config) => config.listenPort)
    .sort((a, b) => a - b);
  const ordered = [...(node.doorPort ? [node.doorPort] : []), ...own, ...extra];
  return [...new Set(ordered)]
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535)
    .slice(0, MAX_CANDIDATE_PORTS);
}

/** The host names the database records for a node: its mirror name, the
 * names its TLS inbounds are verified against by every client today, and
 * its IKEv2 name. Each is a name of ours that an operator gave this node,
 * so a publicly trusted certificate for one of them, presented at the
 * node's own address, is the node's. */
export function knownNames(node: { mirrorHost?: string | null }, configs: DoorConfig[]): string[] {
  const names: unknown[] = [node.mirrorHost];
  for (const config of configs) {
    const params = (config.publicParamsJson ?? {}) as Record<string, unknown>;
    if (presentsOurCertificate(config)) names.push(params.serverName);
    if (config.protocol === "IKEV2") names.push(params.endpointHost);
  }
  return [
    ...new Set(
      names
        .filter((name): name is string => typeof name === "string")
        .map((name) => name.trim().toLowerCase())
        .filter(isHostName),
    ),
  ];
}

// ---- The certificate -----------------------------------------------

/** The DNS names in a certificate's subjectAltName.
 *
 * Node prints the extension as one string and quotes any name holding a
 * character that could be mistaken for its separators. No name of ours
 * needs quoting, so a string with a quote in it has no names here:
 * nothing is parsed out of text a certificate's author could shape. */
function dnsNames(cert: X509Certificate): string[] {
  const text = cert.subjectAltName ?? "";
  if (text.includes('"')) return [];
  return text
    .split(", ")
    .filter((entry) => entry.startsWith("DNS:"))
    .map((entry) => entry.slice("DNS:".length).toLowerCase());
}

/** Whether a certificate names a host of ours: one of `names` (matched
 * the way a browser matches a name, wildcards included), or any host
 * under one of `domains`.
 *
 * This is half of what makes a certificate acceptable. The other half --
 * that a public CA issued it and it is within its dates -- is the TLS
 * handshake's, against the public roots (door-prober.ts). Neither is
 * enough alone: anyone can issue themselves a certificate with our name
 * in it, and anyone can get a real one for a name of their own. */
export function certificateIsOurs(cert: X509Certificate, names: string[], domains: string[]): boolean {
  // The subject's common name is not consulted: public CAs put every
  // name in subjectAltName, and a name only in the subject is not one a
  // client would have matched either.
  if (names.some((name) => cert.checkHost(name, { subject: "never" }) !== undefined)) return true;
  return dnsNames(cert).some((san) => {
    const host = san.startsWith("*.") ? san.slice(2) : san;
    return isHostName(host) && domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  });
}

/** The pin of a certificate's key: `sha256/` and the base64 of the
 * SHA-256 of its DER SubjectPublicKeyInfo. What the apps compute for the
 * relay of last resort (relay_http.rs, `spki_sha256`), and what
 * `openssl x509 -pubkey | openssl pkey -pubin -outform der | openssl dgst
 * -sha256 -binary | base64` prints. */
export function spkiPin(cert: X509Certificate): string {
  const spki = cert.publicKey.export({ type: "spki", format: "der" });
  return PIN_PREFIX + createHash("sha256").update(spki).digest("base64");
}

// ---- Recording and handing out --------------------------------------

/** What one passing check found. */
export interface DoorSighting {
  port: number;
  sni: string | null;
  pin: string;
}

/** The columns to write after a passing check.
 *
 * A change of key keeps the old pin as the previous one. Let's Encrypt
 * renewals make a new key each time, so every node's pin changes every
 * couple of months; a node may also present the old key again for a
 * while (a second listener not yet reloaded). An unchanged key leaves
 * the previous pin and its date as they were. */
export function recordSighting(stored: DoorColumns, seen: DoorSighting, now: Date) {
  const changed = !!stored.doorPin && stored.doorPin !== seen.pin;
  return {
    doorPort: seen.port,
    doorSni: seen.sni,
    doorPin: seen.pin,
    doorVerifiedAt: now,
    ...(changed ? { doorPreviousPin: stored.doorPin, doorPinChangedAt: now } : {}),
  };
}

/** What changed between the stored door and a sighting, in words for one
 * log line; null when nothing did. */
export function sightingChange(stored: DoorColumns, seen: DoorSighting): string | null {
  if (!stored.doorPin || !stored.doorPort) return `door learned on port ${seen.port}`;
  const parts: string[] = [];
  if (stored.doorPort !== seen.port) parts.push(`port ${stored.doorPort} -> ${seen.port}`);
  if (stored.doorPin !== seen.pin) parts.push("certificate key changed");
  if ((stored.doorSni ?? null) !== seen.sni) parts.push("server name changed");
  return parts.length > 0 ? `door changed: ${parts.join(", ")}` : null;
}

/** The door a client is handed for a node, or undefined.
 *
 * Undefined while doors are switched off, for a node that is retired or
 * was never set up, for one with no door, and for one whose door has not
 * passed a check within DOOR_FRESH_MS. */
export function doorOf(node: DoorColumns, now: number = Date.now()): Door | undefined {
  if (!nodeDoorsEnabled()) return undefined;
  if (node.status === "DISABLED" || node.status === "PENDING") return undefined;
  if (!node.doorPort || !node.doorPin || !node.doorVerifiedAt) return undefined;
  if (now - node.doorVerifiedAt.getTime() > DOOR_FRESH_MS) return undefined;
  const pins = [node.doorPin];
  if (
    node.doorPreviousPin &&
    node.doorPreviousPin !== node.doorPin &&
    node.doorPinChangedAt &&
    now - node.doorPinChangedAt.getTime() <= PREVIOUS_PIN_MS
  ) {
    pins.push(node.doorPreviousPin);
  }
  return {
    host: node.publicIp,
    port: node.doorPort,
    pins,
    sni: node.doorSni ?? null,
  };
}
