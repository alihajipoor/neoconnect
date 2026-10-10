import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { isIP } from "node:net";
import { PrismaService } from "../../prisma/prisma.service";

/** An entry every shipped client understands: a base reached by name and
 * verified against that name's certificate. */
export interface StandardEntry {
  kind: "panel" | "mirror";
  url: string;
  pin?: string;
  region?: string;
}

/** The relay of last resort: a server reached by IPv4 address with no
 * SNI, whose certificate the client pins by SPKI hash because there is no
 * name for it to match.
 *
 * It is its own kind, and that is the safety property rather than a
 * label. Every client shipped since 2026-09-01 keeps only "panel" and
 * "mirror" from a verified bundle and drops anything else, so a new kind
 * is invisible to them. The same URL under "panel" would instead send
 * them to an address whose certificate cannot match a name, and every
 * request through it would fail.
 */
export interface LastResortEntry {
  kind: "lastResort";
  url: string;
  pins: string[];
  region?: string;
}

export type EndpointEntry = StandardEntry | LastResortEntry;

/** One operator-configured entry, as POST /admin/endpoints/panel-bases
 * takes it and panelBasesJson stores it. `kind` is optional because every
 * value stored before lastResort existed has none, and all of those are
 * panel bases. Mirrors are absent on purpose: they are derived from the
 * nodes table and never configured. */
export type ConfiguredBase =
  | { kind?: "panel"; url: string; pin?: string; region?: string }
  | { kind: "lastResort"; url: string; pins: string[]; region?: string };

export interface EndpointBundleDraft {
  v: number;
  issuedAt: string;
  endpoints: EndpointEntry[];
}

/** The port every node's nginx already answers /api on, behind the Xray
 * TLS inbound. Not configurable here on purpose: it is a property of the
 * installer's fallback site, and a second place to set it is a second
 * place for the two to disagree. */
const MIRROR_PORT = 2053;

/** More than one pin lets a standby key be listed before it is needed, so
 * the relay's certificate can be rotated without a bundle and a release
 * landing on the same day. More than three is a list nobody is managing. */
const MAX_PINS = 3;

const PIN_PREFIX = "sha256/";

/** Whether the URL's host is an IP address rather than a name.
 *
 * Read from the parsed hostname, not the string as typed: the URL parser
 * accepts an IPv4 address in decimal, octal and hex spellings and
 * normalises every one of them to a dotted quad, so a check on the raw
 * text would let "https://3221225985/api" through as a name. IPv6 hosts
 * come back in brackets, which isIP does not accept.
 */
function hasIpHost(url: URL): boolean {
  return isIP(url.hostname.replace(/^\[(.*)\]$/, "$1")) !== 0;
}

/** Why `raw` cannot be a base reached by name, or null if it can.
 *
 * This is the rule for every panel and mirror entry. Shipped clients
 * verify those against the certificate's name, and an address can never
 * match one; an address that is meant to be used needs a pin, and that
 * is what lastResort is for.
 */
function namedBaseProblem(raw: string): string | null {
  // Checked on the text as well as the parsed protocol because shipped
  // clients test the prefix literally, and "HTTPS://" would be dropped
  // there even though the URL parser accepts it.
  if (!raw.startsWith("https://")) return "url must be https";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "url is not a valid URL";
  }
  if (hasIpHost(url)) {
    return (
      "url must name a DNS host, not an IP address: clients check this entry's " +
      "certificate against its name, so an address fails every request (a pinned " +
      "address belongs in a lastResort entry)"
    );
  }
  return null;
}

/** Why `pin` is not an SPKI pin a client can compare, or null. */
function pinProblem(pin: unknown): string | null {
  if (typeof pin !== "string") return "must be a string";
  if (!pin.startsWith(PIN_PREFIX)) return `must start with "${PIN_PREFIX}"`;
  const encoded = pin.slice(PIN_PREFIX.length);
  if (encoded.length !== 44) {
    return `must have exactly 44 base64 characters after "${PIN_PREFIX}", not ${encoded.length}`;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return "is not standard base64";
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== 32) return `must decode to 32 bytes (a SHA-256 digest), not ${bytes.length}`;
  // Base64 has more than one spelling of the same bytes when the unused
  // trailing bits are set. A client compares against the canonical one
  // it computes, so any other spelling would never match and the relay
  // would refuse every connection while looking correctly configured.
  if (bytes.toString("base64") !== encoded) return "is not the canonical base64 of its bytes";
  return null;
}

/** Why `e` is not a usable lastResort entry, or null. */
function lastResortProblem(e: Record<string, unknown>): string | null {
  if (typeof e.url !== "string") return "url must be a string";
  const raw = e.url;
  if (!raw.startsWith("https://")) return "url must be https";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "url is not a valid URL";
  }
  if (url.username !== "" || url.password !== "") return "url must not carry userinfo";
  // The raw text as well as the parsed parts, because the parser drops an
  // empty "?" or "#" and the entry is signed and compared as typed.
  if (url.search !== "" || raw.includes("?")) return "url must not carry a query";
  if (url.hash !== "" || raw.includes("#")) return "url must not carry a fragment";
  if (isIP(url.hostname) !== 4) {
    return (
      "url host must be an IPv4 address: the relay is reached by address with " +
      "no SNI, and its certificate is checked by pin rather than by name"
    );
  }
  if (url.pathname !== "/api") return "url path must be /api";
  // Everything above passing still leaves spellings the parser rewrites:
  // an address in decimal or with leading zeros, an explicit :443, an
  // empty "@". The signed bundle must carry the one form a client and a
  // reviewer both read the same way, so anything else is refused with
  // that form named rather than silently rewritten.
  const canonical = `https://${url.host}/api`;
  if (raw !== canonical) return `url must be written as ${canonical}`;

  if (e.pin !== undefined) return "a lastResort entry takes pins (a list), not pin";
  if (!Array.isArray(e.pins)) return "pins must be a list of 1 to 3 SPKI pins";
  if (e.pins.length < 1 || e.pins.length > MAX_PINS) {
    return `pins must hold 1 to ${MAX_PINS} entries, not ${e.pins.length}`;
  }
  for (let i = 0; i < e.pins.length; i += 1) {
    const problem = pinProblem(e.pins[i]);
    if (problem) return `pins[${i}] ${problem}`;
  }
  // A repeated pin reads as a standby that does not exist, which is
  // found out only on the day the live key has to be replaced.
  if (new Set(e.pins).size !== e.pins.length) return "pins must be distinct";
  if (e.region !== undefined && typeof e.region !== "string") return "region must be a string";
  return null;
}

/** An operator-configured entry as it may go into the bundle, or the
 * reason it may not.
 *
 * Shared by the write (which refuses) and the draft (which skips), so a
 * value stored before these rules existed is held to them too.
 */
function configuredEntry(raw: unknown): StandardEntry | LastResortEntry | string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return "each entry must be an object";
  }
  const e = raw as Record<string, unknown>;
  const kind = e.kind ?? "panel";

  if (kind === "panel") {
    if (typeof e.url !== "string") return "url must be a string";
    const problem = namedBaseProblem(e.url);
    if (problem) return problem;
    if (e.pins !== undefined) return "pins belongs to lastResort entries; a panel entry takes pin";
    if (e.pin !== undefined && typeof e.pin !== "string") return "pin must be a string";
    if (e.region !== undefined && typeof e.region !== "string") return "region must be a string";
    return { kind: "panel", url: e.url, pin: e.pin, region: e.region };
  }

  if (kind === "lastResort") {
    const problem = lastResortProblem(e);
    if (problem) return problem;
    const entry: LastResortEntry = {
      kind: "lastResort",
      url: e.url as string,
      pins: [...(e.pins as string[])],
    };
    if (typeof e.region === "string") entry.region = e.region;
    return entry;
  }

  if (kind === "mirror") {
    return 'kind "mirror" cannot be configured: mirrors are derived from ONLINE nodes with a mirror host';
  }
  return `kind must be "panel" or "lastResort", not ${JSON.stringify(kind)}`;
}

/** Builds and stores the endpoint bundle.
 *
 * This service never signs. The draft goes out unsigned, the owner signs
 * it on a machine that is not this one, and the signed blob comes back
 * to be stored verbatim -- see EndpointBundleState in the schema for why
 * the key must not live on the panel.
 */
@Injectable()
export class EndpointsService {
  private readonly logger = new Logger(EndpointsService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async state() {
    const existing = await this.prisma.endpointBundleState.findFirst();
    if (existing) return existing;
    return this.prisma.endpointBundleState.create({ data: {} });
  }

  /** What the client should be told to try, unsigned and ready to sign.
   *
   * Node mirrors are derived rather than stored: a node added in the
   * panel is in the next draft automatically, and there is no second
   * list to forget to update. Only ONLINE nodes are included -- a mirror
   * on a node that is not reachable is an endpoint whose whole
   * contribution is an eight-second timeout on the client's first
   * request.
   *
   * Configured lastResort entries go last, after the mirrors. The order
   * is the operator's statement of preference, and a relay of last
   * resort is the least preferred thing the list can name.
   */
  async draft(): Promise<EndpointBundleDraft> {
    const state = await this.state();

    const panels: StandardEntry[] = [];
    const lastResort: LastResortEntry[] = [];
    try {
      const parsed: unknown = JSON.parse(state.panelBasesJson);
      if (Array.isArray(parsed)) {
        for (const raw of parsed) {
          const entry = configuredEntry(raw);
          if (typeof entry === "string") {
            // Skipped rather than thrown, for the same reason as a
            // malformed setting below. It can only be a value stored
            // before the write-side checks existed, or edited by hand.
            this.logger.warn(`Configured endpoint left out of the draft: ${entry}`);
          } else if (entry.kind === "lastResort") {
            lastResort.push(entry);
          } else {
            panels.push(entry);
          }
        }
      }
    } catch {
      // A malformed setting must not stop the node mirrors reaching the
      // draft -- those are the entries that keep censored customers
      // working, and they are derived rather than configured.
      panels.length = 0;
      lastResort.length = 0;
    }

    const nodes = await this.prisma.node.findMany({
      // A mirror is only worth listing if a client can both reach it and
      // verify it. `mirrorHost` is the second half: addressed by IP the
      // certificate does not match, and every entry fails validation --
      // which is exactly what the first version of this shipped.
      where: { status: "ONLINE", mirrorHost: { not: null } },
      select: { name: true, region: true, mirrorHost: true },
      orderBy: { name: "asc" },
    });

    const mirrors: StandardEntry[] = [];
    for (const n of nodes) {
      const url = `https://${n.mirrorHost}:${MIRROR_PORT}/api`;
      // mirrorHost is free text in the nodes table, and an address typed
      // there would put the first version's defect back: a mirror that
      // every certificate-checking client rejects. Only that node's entry
      // is skipped, not the draft refused -- the other mirrors are what
      // keep censored customers working.
      const problem = namedBaseProblem(url);
      if (problem) {
        this.logger.warn(`Mirror for node ${n.name} left out of the draft: ${problem}`);
        continue;
      }
      mirrors.push({
        kind: "mirror",
        url,
        // Region carried so a client can prefer an in-country mirror. That
        // ordering is the difference between working and not when consumer
        // links lose international reach but domestic routing survives.
        region: n.region.split("-")[0]?.toLowerCase(),
      });
    }

    return {
      v: state.version + 1,
      issuedAt: new Date().toISOString(),
      endpoints: [...panels, ...mirrors, ...lastResort],
    };
  }

  /** Stores a signed envelope, verbatim.
   *
   * Validated only as far as "this parses and claims a newer version".
   * The signature is NOT checked here and could not usefully be: the
   * panel does not hold the key, and a panel that verified would only be
   * proving something to itself. The client verifies, which is the only
   * place it counts.
   */
  async publish(signed: string): Promise<{ version: number }> {
    let version: number;
    try {
      const envelope = JSON.parse(signed) as { payload?: string };
      if (typeof envelope.payload !== "string") throw new Error("no payload");
      const payload = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as {
        v?: unknown;
        endpoints?: unknown;
      };
      if (typeof payload.v !== "number" || !Number.isFinite(payload.v)) {
        throw new Error("payload has no numeric v");
      }
      if (!Array.isArray(payload.endpoints) || payload.endpoints.length === 0) {
        throw new Error("payload has no endpoints");
      }
      version = payload.v;
    } catch (err) {
      throw new BadRequestException(`Not a usable signed bundle: ${(err as Error).message}`);
    }

    const state = await this.state();
    if (version <= state.version) {
      // Refused rather than accepted-and-ignored: publishing a version
      // clients will not take is a silent no-op, and the operator would
      // believe the rollout happened.
      throw new BadRequestException(
        `Version ${version} is not newer than the published ${state.version}; clients only accept a strictly higher version.`,
      );
    }

    await this.prisma.endpointBundleState.update({
      where: { id: state.id },
      data: { signed, version },
    });
    return { version };
  }

  /** The published envelope, or 404.
   *
   * Deliberately not "an empty bundle": a client must be able to tell
   * "nothing has been published" from "a bundle that says go nowhere",
   * and the second would overwrite a good cached list with a useless one.
   */
  async published(): Promise<string> {
    const state = await this.state();
    if (!state.signed) throw new NotFoundException("No endpoint bundle has been published yet");
    return state.signed;
  }

  /** Replaces the operator-configured entries.
   *
   * Takes `unknown` because the body arrives as untyped JSON: the route
   * has no validating DTO, so these checks are the only ones it gets.
   * The whole list is refused on the first bad entry, naming it, rather
   * than the good ones being stored -- a partial save would leave the
   * operator believing a relay or panel is listed when it is not. What is
   * stored is the normalised entry, not the body, so stray fields never
   * reach a draft.
   */
  async setPanelBases(entries: unknown): Promise<void> {
    if (!Array.isArray(entries)) throw new BadRequestException("entries must be a list");
    const stored: EndpointEntry[] = entries.map((raw, i) => {
      const entry = configuredEntry(raw);
      if (typeof entry === "string") throw new BadRequestException(`entries[${i}]: ${entry}`);
      return entry;
    });
    const state = await this.state();
    await this.prisma.endpointBundleState.update({
      where: { id: state.id },
      data: { panelBasesJson: JSON.stringify(stored) },
    });
  }
}
