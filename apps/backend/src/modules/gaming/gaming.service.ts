import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PlanFeatureKey, Prisma, SubscriptionStatus } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { CreateGameProfileDto } from "./dto/create-game-profile.dto";
import { UpdateGameProfileDto } from "./dto/update-game-profile.dto";
import { CreateGamingResolverDto } from "./dto/create-gaming-resolver.dto";
import { UpdateGamingResolverDto } from "./dto/update-gaming-resolver.dto";

/** How long a node's confirmation is trusted for.
 *
 * A resolver that acked once and then went quiet is not serving anything, and
 * handing a client a resolver that no longer answers produces the exact
 * defect this project keeps finding: an app that says a thing is on while
 * nothing is carrying traffic. Thirteen relay routes once reported ONLINE
 * with every one of them dead, because health was inferred once and never
 * re-checked.
 *
 * Two hours rather than minutes because nothing re-asserts gaming resolvers
 * yet (there is no node-side implementation at all, see the module doc), so a
 * tighter window would only express confidence the system cannot back. When a
 * re-assert sweep exists this should come down to roughly twice its period. */
const RESOLVER_CONFIRMATION_TTL_MS = 2 * 60 * 60 * 1000;

/** Statuses that mean the customer is entitled to something right now.
 *
 * PENDING is excluded deliberately: it is a plan picked and not paid for. */
const LIVE_SUBSCRIPTION_STATUSES = [SubscriptionStatus.ACTIVE] as const;

/** Why gaming mode is not usable, in a form the client can map to a sentence
 * in the customer's own language.
 *
 * A machine-readable reason rather than a message, because the client renders
 * Persian and English and must never be handed English prose to display. And
 * an explicit `null` for "usable" rather than an absent field, so a client
 * that forgets to check gets `null` and not `undefined`. */
export type GamingUnavailableReason = "noSubscription" | "notEntitled" | "noResolver";

/** What the desktop and mobile clients receive.
 *
 * `version` is a shape discriminator, matching the client's own cache
 * convention: the client discards a cached payload whose version it does not
 * recognise rather than trying to migrate it. Bump it on any breaking change
 * to this shape. */
export interface GamingProfilePayload {
  version: 1;
  entitled: boolean;
  unavailableReason: GamingUnavailableReason | null;
  resolver: {
    dohUrl: string;
    proxyIp: string;
    proxyPort: number;
    nodeRegion: string;
  } | null;
  games: {
    slug: string;
    displayName: string;
    iconKey: string | null;
    publisher: string | null;
    hostnames: string[];
    excludeHostnames: string[];
    canaryHostname: string | null;
  }[];
}

/** The one place a resolver row is turned into something a client may act on.
 *
 * Written as a named projection rather than inline so there is a single
 * answer to "what does the client know about a node", and so nothing can
 * accidentally widen it -- the whole row carries operator-facing fields, and
 * `protocol-users.service.ts` already carries the scar from a payload that
 * leaked more than intended. */
const RESOLVER_CLIENT_FIELDS = {
  id: true,
  dohHost: true,
  dohPort: true,
  proxyIp: true,
  proxyPort: true,
  confirmedAt: true,
  node: { select: { region: true } },
} satisfies Prisma.GamingResolverSelect;

@Injectable()
export class GamingService {
  private readonly logger = new Logger(GamingService.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Game profiles (admin)
  // -------------------------------------------------------------------------

  listProfiles() {
    return this.prisma.gameProfile.findMany({
      orderBy: [{ sortOrder: "asc" }, { displayName: "asc" }],
    });
  }

  async getProfile(id: string) {
    const profile = await this.prisma.gameProfile.findUnique({ where: { id } });
    if (!profile) {
      throw new NotFoundException("Game profile not found");
    }
    return profile;
  }

  async createProfile(dto: CreateGameProfileDto) {
    const hostnames = normaliseHosts(dto.hostnames);
    const excludeHostnames = normaliseHosts(dto.excludeHostnames);
    // Normalise the canary through the SAME function as the hostnames before
    // comparing. Comparing a raw value against normalised ones rejected a
    // perfectly good canary typed in a different case -- found by the test
    // below, not by reading.
    const canaryHostname = normaliseHosts(
      dto.canaryHostname ? [dto.canaryHostname] : undefined,
    )[0] ?? null;
    this.assertProfileCoherent(hostnames, excludeHostnames, canaryHostname);

    return this.prisma.gameProfile.create({
      data: {
        slug: dto.slug,
        displayName: dto.displayName,
        publisher: dto.publisher ?? null,
        iconKey: dto.iconKey ?? null,
        hostnames,
        excludeHostnames,
        processNames: dto.processNames ?? [],
        destinationCidrs: dto.destinationCidrs ?? [],
        destinationAsn: dto.destinationAsn ?? null,
        prefixComplete: dto.prefixComplete ?? false,
        canaryHostname,
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
        notes: dto.notes ?? null,
      },
    });
  }

  async updateProfile(id: string, dto: UpdateGameProfileDto) {
    const existing = await this.getProfile(id);

    // Validate against the row as it will be, not as it was. A PATCH that
    // changes only `hostnames` can invalidate a `canaryHostname` set in an
    // earlier request, and checking the DTO alone would let that through.
    const hostnames = dto.hostnames ? normaliseHosts(dto.hostnames) : existing.hostnames;
    const excludeHostnames = dto.excludeHostnames
      ? normaliseHosts(dto.excludeHostnames)
      : existing.excludeHostnames;
    const canary =
      dto.canaryHostname === undefined
        ? existing.canaryHostname
        : (normaliseHosts(dto.canaryHostname ? [dto.canaryHostname] : undefined)[0] ?? null);

    this.assertProfileCoherent(hostnames, excludeHostnames, canary);

    return this.prisma.gameProfile.update({
      where: { id },
      data: {
        slug: dto.slug,
        displayName: dto.displayName,
        publisher: dto.publisher,
        iconKey: dto.iconKey,
        hostnames: dto.hostnames ? hostnames : undefined,
        excludeHostnames: dto.excludeHostnames ? excludeHostnames : undefined,
        processNames: dto.processNames,
        destinationCidrs: dto.destinationCidrs,
        destinationAsn: dto.destinationAsn,
        prefixComplete: dto.prefixComplete,
        canaryHostname: dto.canaryHostname === undefined ? undefined : canary,
        sortOrder: dto.sortOrder,
        isActive: dto.isActive,
        notes: dto.notes,
      },
    });
  }

  async removeProfile(id: string) {
    await this.getProfile(id);
    await this.prisma.gameProfile.delete({ where: { id } });
  }

  /** The rules that make a profile mean something, checked in one place.
   *
   * Each of these is a way to save a profile that looks configured in the
   * panel and does nothing on a customer's machine -- the failure mode this
   * whole feature is most exposed to, because nothing downstream would
   * complain. */
  private assertProfileCoherent(
    hostnames: string[],
    excludeHostnames: string[],
    canaryHostname: string | null,
  ) {
    if (canaryHostname && !hostnames.includes(canaryHostname)) {
      throw new BadRequestException(
        "canaryHostname must be one of the redirected hostnames -- a canary that is not redirected proves nothing, and the client would never be able to report more than 'partial'",
      );
    }

    const contradictory = excludeHostnames.filter((host) => hostnames.includes(host));
    if (contradictory.length > 0) {
      throw new BadRequestException(
        `These hostnames are in both the redirect list and the exclude list, so it is impossible to say what was intended: ${contradictory.join(", ")}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Resolvers (admin)
  // -------------------------------------------------------------------------

  listResolvers() {
    return this.prisma.gamingResolver.findMany({
      orderBy: { createdAt: "asc" },
      include: { node: { select: { id: true, name: true, region: true } } },
    });
  }

  async createResolver(dto: CreateGamingResolverDto) {
    const node = await this.prisma.node.findUnique({ where: { id: dto.nodeId } });
    if (!node) {
      throw new NotFoundException("Node not found");
    }

    const existing = await this.prisma.gamingResolver.findUnique({
      where: { nodeId: dto.nodeId },
    });
    if (existing) {
      throw new BadRequestException(`${node.name} already has a gaming resolver`);
    }

    return this.prisma.gamingResolver.create({
      data: {
        nodeId: dto.nodeId,
        dohHost: dto.dohHost.toLowerCase(),
        dohPort: dto.dohPort ?? 443,
        proxyIp: dto.proxyIp,
        proxyPort: dto.proxyPort ?? 443,
        isEnabled: dto.isEnabled ?? false,
      },
      include: { node: { select: { id: true, name: true, region: true } } },
    });
  }

  async updateResolver(id: string, dto: UpdateGamingResolverDto) {
    const existing = await this.prisma.gamingResolver.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException("Gaming resolver not found");
    }

    // Changing where the resolver lives or what it answers with invalidates
    // the node's confirmation, so drop it rather than carry it forward. The
    // alternative is a row that claims to be confirmed for an endpoint that
    // was never tested -- which is precisely the lie this column exists to
    // prevent.
    const endpointChanged =
      (dto.dohHost !== undefined && dto.dohHost.toLowerCase() !== existing.dohHost) ||
      (dto.dohPort !== undefined && dto.dohPort !== existing.dohPort) ||
      (dto.proxyIp !== undefined && dto.proxyIp !== existing.proxyIp) ||
      (dto.proxyPort !== undefined && dto.proxyPort !== existing.proxyPort);

    if (endpointChanged) {
      this.logger.log(
        `Gaming resolver ${id} endpoint changed; clearing its confirmation until the node acks again`,
      );
    }

    return this.prisma.gamingResolver.update({
      where: { id },
      data: {
        dohHost: dto.dohHost?.toLowerCase(),
        dohPort: dto.dohPort,
        proxyIp: dto.proxyIp,
        proxyPort: dto.proxyPort,
        isEnabled: dto.isEnabled,
        confirmedAt: endpointChanged ? null : undefined,
        lastError: endpointChanged ? null : undefined,
      },
      include: { node: { select: { id: true, name: true, region: true } } },
    });
  }

  async removeResolver(id: string) {
    const existing = await this.prisma.gamingResolver.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException("Gaming resolver not found");
    }
    await this.prisma.gamingResolver.delete({ where: { id } });
  }

  // -------------------------------------------------------------------------
  // Plan features (admin)
  // -------------------------------------------------------------------------

  async listPlanFeatures() {
    const plans = await this.prisma.subscriptionPlan.findMany({
      orderBy: { priceUsd: "asc" },
      select: { id: true, name: true, features: { select: { feature: true } } },
    });

    return plans.map((plan) => ({
      planId: plan.id,
      planName: plan.name,
      features: plan.features.map((row) => row.feature),
    }));
  }

  async setPlanFeatures(planId: string, features: PlanFeatureKey[]) {
    const plan = await this.prisma.subscriptionPlan.findUnique({ where: { id: planId } });
    if (!plan) {
      throw new NotFoundException("Plan not found");
    }

    // Whole-set semantics, applied atomically. Delete-then-insert rather than
    // a diff because the set is two rows at most and a diff would be more
    // code to get wrong than it saves.
    await this.prisma.$transaction([
      this.prisma.planFeature.deleteMany({ where: { planId } }),
      this.prisma.planFeature.createMany({
        data: features.map((feature) => ({ planId, feature })),
      }),
    ]);

    return {
      planId,
      planName: plan.name,
      features,
    };
  }

  // -------------------------------------------------------------------------
  // Customer-facing
  // -------------------------------------------------------------------------

  /** Everything a client needs to arm gaming mode, or an honest reason it
   * cannot.
   *
   * Deliberately its own endpoint rather than a field on
   * `/customer/protocol-users`. That payload is filtered through the
   * `CLIENT_VISIBLE_PUBLIC_PARAMS` whitelist, so a field added anywhere near
   * it silently never reaches the client, and the desktop app caches it
   * behind a version discriminator that would have to be bumped -- which
   * would throw away every customer's cached credentials to ship a feature
   * that has nothing to do with them. */
  async profileForCustomer(customerId: string): Promise<GamingProfilePayload> {
    const games = await this.prisma.gameProfile.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { displayName: "asc" }],
      select: {
        slug: true,
        displayName: true,
        iconKey: true,
        publisher: true,
        hostnames: true,
        excludeHostnames: true,
        canaryHostname: true,
      },
    });

    const entitlement = await this.entitlementFor(customerId);
    if (entitlement.reason) {
      // The catalogue still travels, so the app can show what gaming mode
      // would cover and explain what is missing, rather than an empty screen
      // that reads as a broken app. Nothing here is a credential.
      return { version: 1, entitled: false, unavailableReason: entitlement.reason, resolver: null, games };
    }

    const resolver = await this.usableResolver();
    if (!resolver) {
      // Entitled, but there is no node serving this. Say exactly that. The
      // client must not dress it up as a network failure: nothing was
      // dialled, so "could not reach the server" would be false.
      return { version: 1, entitled: true, unavailableReason: "noResolver", resolver: null, games };
    }

    const token = await this.resolverTokenFor(customerId);

    return {
      version: 1,
      entitled: true,
      unavailableReason: null,
      resolver: {
        // Path-token auth, per RFC 8484's POST form. A source-IP allowlist
        // cannot work here: Iranian consumer networks are behind CGNAT, so
        // the address is neither stable nor unique to one customer.
        dohUrl: `https://${resolver.dohHost}:${resolver.dohPort}/dns-query/${token}`,
        proxyIp: resolver.proxyIp,
        proxyPort: resolver.proxyPort,
        nodeRegion: resolver.node.region,
      },
      games,
    };
  }

  /** Whether this customer's plan grants gaming DNS right now.
   *
   * Note what is NOT considered: `GAMING_PRIVATE_EXIT`. It is never reported
   * to a client and never gates anything, because the mechanism behind it
   * does not exist. Granting it in the panel has no effect by design -- the
   * alternative is an app that offers a customer something no code
   * implements. */
  private async entitlementFor(
    customerId: string,
  ): Promise<{ reason: GamingUnavailableReason | null }> {
    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        customerId,
        status: { in: [...LIVE_SUBSCRIPTION_STATUSES] },
        expireAt: { gt: new Date() },
      },
      select: { plan: { select: { features: { select: { feature: true } } } } },
    });

    if (subscriptions.length === 0) {
      return { reason: "noSubscription" };
    }

    const granted = subscriptions.some((subscription) =>
      subscription.plan.features.some((row) => row.feature === PlanFeatureKey.GAMING_DNS),
    );

    return { reason: granted ? null : "notEntitled" };
  }

  /** The first resolver that is both switched on and has actually confirmed
   * recently.
   *
   * `isEnabled` alone is not enough and never will be. It records the
   * operator's intent; `confirmedAt` records the node's report. Offering a
   * resolver on intent alone is how a client ends up telling a customer in
   * Iran that gaming mode is on while nothing is listening. */
  private async usableResolver() {
    const freshEnough = new Date(Date.now() - RESOLVER_CONFIRMATION_TTL_MS);

    return this.prisma.gamingResolver.findFirst({
      where: {
        isEnabled: true,
        confirmedAt: { not: null, gte: freshEnough },
      },
      orderBy: { confirmedAt: "desc" },
      select: RESOLVER_CLIENT_FIELDS,
    });
  }

  /** This customer's resolver token, minting one on first use.
   *
   * Created lazily rather than at signup so the overwhelming majority of
   * customers -- everyone who never opens gaming mode -- never have a bearer
   * credential sitting in the database at all. */
  private async resolverTokenFor(customerId: string): Promise<string> {
    const existing = await this.prisma.gamingResolverToken.findUnique({
      where: { customerId },
      select: { token: true, revokedAt: true },
    });

    if (existing && !existing.revokedAt) {
      return existing.token;
    }

    // 32 bytes, base64url: URL-safe without escaping, and well past anything
    // worth guessing at a path that will be rate-limited anyway.
    const token = randomBytes(32).toString("base64url");

    await this.prisma.gamingResolverToken.upsert({
      where: { customerId },
      create: { customerId, token },
      update: { token, revokedAt: null, createdAt: new Date() },
    });

    return token;
  }
}

/** Hostnames are compared, deduplicated and matched case-insensitively
 * everywhere downstream -- in the resolver, in the client's namespace rules,
 * and in the canary check. Normalising once here means none of those three
 * has to remember to, and that they cannot disagree. */
function normaliseHosts(hosts: string[] | undefined): string[] {
  if (!hosts) {
    return [];
  }
  const seen = new Set<string>();
  for (const host of hosts) {
    const trimmed = host.trim().toLowerCase().replace(/\.$/, "");
    if (trimmed) {
      seen.add(trimmed);
    }
  }
  return [...seen];
}
