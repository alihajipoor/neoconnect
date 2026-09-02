import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

export interface EndpointEntry {
  kind: "panel" | "mirror";
  url: string;
  pin?: string;
  region?: string;
}

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

/** Builds and stores the endpoint bundle.
 *
 * This service never signs. The draft goes out unsigned, the owner signs
 * it on a machine that is not this one, and the signed blob comes back
 * to be stored verbatim -- see EndpointBundleState in the schema for why
 * the key must not live on the panel.
 */
@Injectable()
export class EndpointsService {
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
   */
  async draft(): Promise<EndpointBundleDraft> {
    const state = await this.state();

    let configured: EndpointEntry[] = [];
    try {
      const parsed: unknown = JSON.parse(state.panelBasesJson);
      if (Array.isArray(parsed)) {
        configured = parsed
          .filter((e): e is EndpointEntry => {
            if (typeof e !== "object" || e === null) return false;
            const entry = e as Record<string, unknown>;
            return typeof entry.url === "string" && entry.url.startsWith("https://");
          })
          .map((e) => ({ kind: "panel" as const, url: e.url, pin: e.pin, region: e.region }));
      }
    } catch {
      // A malformed setting must not stop the node mirrors reaching the
      // draft -- those are the entries that keep censored customers
      // working, and they are derived rather than configured.
      configured = [];
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

    const mirrors: EndpointEntry[] = nodes.map((n) => ({
      kind: "mirror" as const,
      url: `https://${n.mirrorHost}:${MIRROR_PORT}/api`,
      // Region carried so a client can prefer an in-country mirror. That
      // ordering is the difference between working and not when consumer
      // links lose international reach but domestic routing survives.
      region: n.region.split("-")[0]?.toLowerCase(),
    }));

    return {
      v: state.version + 1,
      issuedAt: new Date().toISOString(),
      endpoints: [...configured, ...mirrors],
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

  async setPanelBases(entries: EndpointEntry[]): Promise<void> {
    const bad = entries.filter((e) => !e.url?.startsWith("https://"));
    if (bad.length) {
      throw new BadRequestException("Panel base URLs must be https");
    }
    const state = await this.state();
    await this.prisma.endpointBundleState.update({
      where: { id: state.id },
      data: { panelBasesJson: JSON.stringify(entries) },
    });
  }
}
