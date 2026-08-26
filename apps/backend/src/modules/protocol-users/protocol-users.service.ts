import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { ListWindow, Page } from "../../common/pagination";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.service";
import { decryptCredentials, encryptCredentials } from "./credentials-crypto";
import { CreateProtocolUserDto } from "./dto/create-protocol-user.dto";
import { rateLimitFor } from "./rate-limit";
import { generateCredentials } from "./generate-credentials";

/** Every column of ProtocolUser, named.
 *
 * Unusually for a list projection this narrows nothing today -- the
 * route hands back the whole row and `credentialsJson` is the payload
 * rather than a leak, since decrypting it for an admin is the entire
 * reason the endpoint exists. Naming the columns anyway is the cheap
 * half of the lesson this file already carries a scar from: a bare
 * `findMany` means the next column added to the model joins an
 * admin-wide response without anyone deciding it should, and the next
 * column added here is as likely to be a secret as not. */
const PROTOCOL_USER_LIST_FIELDS = {
  id: true,
  subscriptionId: true,
  routeId: true,
  nodeId: true,
  protocolConfigId: true,
  protocol: true,
  externalUserId: true,
  credentialsJson: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProtocolUserSelect;

/** A listed ProtocolUser as a caller sees it: the encrypted column is
 * gone, replaced by the credentials it held. */
type DecryptedProtocolUser = Omit<
  Prisma.ProtocolUserGetPayload<{ select: typeof PROTOCOL_USER_LIST_FIELDS }>,
  "credentialsJson"
> & { credentials: Record<string, string> };

@Injectable()
export class ProtocolUsersService {
  private readonly logger = new Logger(ProtocolUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentGateway: AgentGatewayService,
  ) {}

  /** The operator's view of provisioned users -- bounded.
   *
   * This is the heaviest list route in the API and the bound matters
   * more here than anywhere else, because of what the route does: every
   * row it returns is run through `withDecryptedCredentials`, so an
   * unfiltered call did an AES-GCM decrypt per customer credential set
   * and put the plaintext of all of them in one response. There is one
   * ProtocolUser per subscription per enabled route, so the table is a
   * multiple of the customer count, not a fraction of it, and `?nodeId`
   * -- the only filter -- is optional. A page of a hundred is still a
   * hundred credential sets; there is no version of this route that is
   * cheap, only one that is bounded.
   *
   * The decryption itself is unchanged for the rows that do come back:
   * an admin fetching credentials to hand to a customer is the reason
   * this endpoint exists. */
  async list(
    nodeId: string | undefined,
    window: ListWindow,
  ): Promise<Page<DecryptedProtocolUser>> {
    const where: Prisma.ProtocolUserWhereInput | undefined = nodeId ? { nodeId } : undefined;

    const [users, total] = await this.prisma.$transaction([
      this.prisma.protocolUser.findMany({
        where,
        orderBy: { createdAt: "desc" },
        select: PROTOCOL_USER_LIST_FIELDS,
        take: window.take,
        skip: window.skip,
      }),
      this.prisma.protocolUser.count({ where }),
    ]);

    return { items: users.map(withDecryptedCredentials), total };
  }

  async get(id: string) {
    const user = await this.getRaw(id);
    return withDecryptedCredentials(user);
  }

  /** Customer-facing: only this customer's own credentials, resolved via
   * subscription ownership -- used by CustomerController, never exposed
   * via the admin-only routes above (which return everyone's).
   *
   * Also includes a `connection` field (server host/port + the entry
   * ProtocolConfig's publicParamsJson) alongside the per-user
   * `credentials` -- WireGuard/OpenVPN's generated credentials already
   * embed everything needed to connect (server pubkey/endpoint, or
   * cert/CA/endpoint), but Xray VLESS+REALITY's per-user credentials are
   * only `{uuid, flow}`; the REALITY server params (public key, shortId,
   * serverName, dest) live purely on the ProtocolConfig and were never
   * returned to a caller before. Uniform across all three protocols on
   * purpose, so a client doesn't need protocol-specific parsing just to
   * find the server address -- this is the field a native client needs
   * to actually build a working local tunnel config. */
  async listByCustomer(customerId: string) {
    const users = await this.prisma.protocolUser.findMany({
      where: { subscription: { customerId } },
      orderBy: { createdAt: "desc" },
      include: { node: true, protocolConfig: true },
    });
    return users.map(({ node, protocolConfig, ...user }) => ({
      ...withDecryptedCredentials(user),
      connection: connectionInfo(node, protocolConfig),
    }));
  }

  /** Internal callers (setEnabled, remove) need the raw encrypted row,
   * not the decrypted API-response shape get() returns. */
  private async getRaw(id: string) {
    const user = await this.prisma.protocolUser.findUnique({
      where: { id },
      // The config comes along so remove/setEnabled can name the same
      // listener create() used. Without it they send only the protocol,
      // which stopped identifying an inbound once one node could serve
      // the same protocol on two of them -- see targetInbound below.
      include: { protocolConfig: { select: { transport: true, inboundTag: true } } },
    });
    if (!user) {
      throw new NotFoundException("Protocol user not found");
    }
    return user;
  }

  async create(dto: CreateProtocolUserDto) {
    const [subscription, route] = await Promise.all([
      // The plan comes along for its bandwidth caps: the node needs them
      // at provisioning time, since a user created without a shaper would
      // run uncapped until something happened to re-provision them.
      this.prisma.subscription.findUnique({
        where: { id: dto.subscriptionId },
        include: { plan: { include: { allowedRoutes: { select: { id: true } } } } },
      }),
      this.prisma.route.findUnique({
        where: { id: dto.routeId },
        // The node comes along for the `connection` field below -- a
        // caller that just provisioned a user is exactly the caller
        // about to connect with it, so it must not have to make a second
        // request to find out where to connect.
        include: { entryProtocolConfig: { include: { node: true } } },
      }),
    ]);
    if (!subscription) throw new BadRequestException("Subscription not found");
    if (!route) throw new BadRequestException("Route not found");
    if (!route.isEnabled) throw new BadRequestException("Route is not enabled");

    // The relay/direct split used to be a rule of its own here, driven
    // by plan.relayOnly. It is gone: a plan is now exactly the set of
    // routes an operator ticked, and a relay route is only different
    // from a direct one in that somebody chose it.
    //
    // What that guard bought is not lost, but it has moved. It existed
    // because provisionAll handed every eligible route to every
    // subscription, so the first relay route created would have put all
    // fifteen live customers onto Iran bandwidth at double the cost
    // within one sweep. Nothing is implicit any more -- an empty
    // selection is empty, not "everything" -- so a route reaches a
    // customer only if it was picked for their plan.
    // The plan's explicit route selection, enforced at the same
    // chokepoint for the same reason: provisionAll's filter decides what
    // is offered, and every other path -- the picker, the admin panel,
    // renewal, a backfill -- arrives here with a routeId instead. A
    // selection that only shaped the offer would be a setting the admin
    // could see and nothing could rely on.
    //
    // Empty means empty. A plan with nothing selected serves nothing,
    // which is the owner's decision -- explicit selection is required --
    // and is why every existing plan was backfilled with its effective
    // routes before this stopped meaning "everything".
    const selectedRouteIds = subscription.plan.allowedRoutes.map((r) => r.id);
    if (!selectedRouteIds.includes(route.id)) {
      throw new BadRequestException(
        `The ${subscription.plan.name} plan is not served by "${route.name}"`,
      );
    }

    const protocolConfig = route.entryProtocolConfig;

    const usedAddresses =
      protocolConfig.protocol === "WIREGUARD" ? await this.usedWireGuardAddresses(protocolConfig.id) : [];

    const { externalUserId, credentials } = generateCredentials(protocolConfig.protocol, protocolConfig, usedAddresses);

    const protocolUser = await this.prisma.protocolUser.create({
      data: {
        subscriptionId: dto.subscriptionId,
        routeId: dto.routeId,
        nodeId: protocolConfig.nodeId,
        protocolConfigId: protocolConfig.id,
        protocol: protocolConfig.protocol,
        externalUserId,
        credentialsJson: encryptCredentials(credentials),
      },
    });

    // Whether this route is direct or relayed is transparent here --
    // the customer is always provisioned on the entry engine only. A
    // relayed route's relay->exit tunnel was already wired once when the
    // Route itself was created (see routes.service.ts).
    await this.agentGateway.enqueueCommand(protocolConfig.nodeId, "CREATE_USER", {
      protocol: protocolConfig.protocol,
      // The protocol alone no longer identifies an inbound: one node can
      // serve VLESS+TLS as a raw TCP stream and inside a WebSocket at
      // once, on the same port and certificate. Without this the agent
      // would add every WS customer to the TCP inbound, handing them a
      // credential that looks correct and never connects.
      transport: protocolConfig.transport,
      ...targetInbound(protocolConfig),
      externalUserId,
      credentials,
      ...rateLimitFor(subscription.plan, protocolConfig.protocol),
    });

    return {
      ...withDecryptedCredentials(protocolUser),
      connection: connectionInfo(protocolConfig.node, protocolConfig),
    };
  }

  /** Provisions this subscription on every route its plan allows.
   *
   * The client holds all of them at once so it can fail over to another
   * protocol without asking the server for anything. That is the whole
   * point: on a censored network the control plane is a plausible thing
   * to lose first, and a fallback that needs the network in order to
   * route around the network being broken is not a fallback.
   *
   * Idempotent, and has to be -- it runs on first payment, on every
   * renewal, when a plan changes, when a new route appears, and from the
   * backfill. Routes the subscription already has are skipped rather
   * than torn down and recreated, so re-running this never disturbs a
   * connected customer.
   */
  async provisionAll(subscriptionId: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: { plan: { include: { allowedRoutes: { select: { id: true } } } } },
    });
    if (!subscription) throw new BadRequestException("Subscription not found");

    // Relayed and direct routes are mutually exclusive per plan, and the
    // filter runs in BOTH directions on purpose.
    //
    // A relayOnly plan (Ultimate) must never be served by a direct
    // route: it is sold as the Iran relay path, and a direct one would
    // be a different product under the same name -- the exact dishonesty
    // the plan is priced against.
    //
    // A normal plan must never pick up a RELAYED route, which is the
    // expensive direction. Relayed traffic crosses two servers and the
    // Iran side costs more per gigabyte, so without this every Starter
    // and Pro customer would be quietly provisioned onto the relay the
    // moment one exists -- paying twice over to serve people who never
    // asked for it. This half is why the flag had to land before the
    // first relay route did.
    // The plan's route selection IS the policy now. No relay/direct
    // filter sits beside it, and no implicit "everything" behind it.
    //
    // An empty selection therefore means no service, which is a real
    // edge with real consequences: a plan nobody has ticked routes for
    // provisions nothing and its customers connect to nothing. That is
    // the owner's decision -- explicit selection is required -- and the
    // migration that backfilled every existing plan's effective routes
    // is what makes it safe to say.
    const selected = subscription.plan.allowedRoutes.map((r) => r.id);
    const selectionFilter = { id: { in: selected } };
    // Two queries rather than one broader one, so each answers exactly
    // one of those questions and neither has to be read as also meaning
    // the other.
    const [routes, allowedByPolicy, existing] = await Promise.all([
      // What can be provisioned now: policy AND currently reachable.
      this.prisma.route.findMany({
        where: {
          isEnabled: true,
          ...selectionFilter,
          entryProtocolConfig: { protocol: { in: subscription.plan.protocolsAllowed }, isEnabled: true },
        },
        select: { id: true },
        orderBy: { name: "asc" },
      }),
      // What the plan allows at all, ignoring whether it happens to be
      // up. Only revocation reads this.
      this.prisma.route.findMany({
        where: {
          ...selectionFilter,
          entryProtocolConfig: { protocol: { in: subscription.plan.protocolsAllowed } },
        },
        select: { id: true },
      }),
      this.prisma.protocolUser.findMany({ where: { subscriptionId }, select: { id: true, routeId: true } }),
    ]);

    const allowedRouteIds = new Set(allowedByPolicy.map((r) => r.id));

    // Fail loudly rather than provisioning nothing. A plan that has
    // routes selected but none of them reachable means the nodes are
    // down or disabled -- and the customer has paid. Silence there looks
    // like a working subscription that simply never connects, which is
    // the worst way for this to fail.
    //
    // A plan with NO routes selected is a different case and not an
    // error: it is an operator who has not finished setting it up, and
    // saying so on every sweep would be noise rather than news.
    if (selected.length > 0 && routes.length === 0) {
      throw new BadRequestException(
        `The ${subscription.plan.name} plan's selected routes are all unavailable right now. ` +
          `No credentials were created -- enable one of its routes before selling this plan.`,
      );
    }

    // Revoke what the plan no longer allows, before adding what it does.
    //
    // provisionAll used to only ever add, which left the flag true of
    // future provisioning and false of the customers who already
    // existed: the two live Ultimate subscribers kept the 16 direct-route
    // credentials they had been given before relayOnly was introduced.
    // The plan is sold as the Iran relay path, so a subscriber quietly
    // holding direct credentials is being sold one product and handed
    // another -- and on the other side, a normal plan holding a relay
    // credential is billing us twice over for traffic nobody asked to
    // send through Iran.
    //
    // Ordered after the "no relay route available" throw above on
    // purpose. If the relay is down, a relayOnly subscription keeps
    // whatever it has rather than being stripped to nothing by an
    // outage: revoking there would turn a node problem into a customer
    // with no credentials at all.
    //
    // Sequential, like the creation loop, because each revocation is an
    // agent command and the failure of one should not leave the rest
    // unattempted in a Promise.all rejection.
    const revoked: string[] = [];
    for (const user of existing) {
      if (allowedRouteIds.has(user.routeId)) continue;
      await this.remove(user.id);
      revoked.push(user.id);
    }
    if (revoked.length > 0) {
      this.logger.warn(
        `provisionAll(${subscriptionId}): revoked ${revoked.length} credential(s) on routes the ` +
          `${subscription.plan.name} plan does not allow`,
      );
    }

    // Rebuilt from the rows that survived, not from the pre-revocation
    // read: a route that was just revoked must be eligible to be created
    // again if policy allows it, and would otherwise be skipped as
    // "already present" while no longer existing.
    const already = new Set(existing.filter((u) => allowedRouteIds.has(u.routeId)).map((u) => u.routeId));
    const created = [];
    for (const route of routes) {
      if (already.has(route.id)) continue;
      // Sequential, not Promise.all: WireGuard address allocation reads
      // the addresses already in use, so two routes on the same node
      // provisioned in parallel can pick the same one.
      created.push(await this.create({ subscriptionId, routeId: route.id }));
    }

    // Both halves, named. This used to return the created users alone,
    // which was the whole story when it could only add -- and once it
    // could also revoke, every caller was structurally unable to see
    // that half. The backfill in particular summarised a sweep as
    // "added N" while the same sweep deleted credentials from live
    // nodes. Returning one array again would rebuild that blind spot.
    return { created, revoked };
  }

  /** Customer-facing: the location picker's "switch server" action.
   *
   * Deliberately non-destructive. It used to remove every existing
   * ProtocolUser and create one for the chosen route, which under
   * provisionAll() would delete exactly the credentials failover depends
   * on -- and the shipped 0.1.0/0.2.0 clients both call this endpoint
   * when a customer picks a server, so the destructive version would
   * have broken apps already in the field.
   *
   * Switching is now a local choice the client makes between credentials
   * it already holds; this endpoint only guarantees the chosen one
   * exists and hands it back.
   */
  async switchRoute(subscriptionId: string, routeId: string) {
    const [subscription, route] = await Promise.all([
      this.prisma.subscription.findUnique({ where: { id: subscriptionId }, include: { plan: true } }),
      this.prisma.route.findUnique({ where: { id: routeId }, include: { entryProtocolConfig: true } }),
    ]);
    if (!subscription) throw new BadRequestException("Subscription not found");
    if (!route) throw new BadRequestException("Route not found");
    if (!route.isEnabled) throw new BadRequestException("Route is not enabled");
    if (!subscription.plan.protocolsAllowed.includes(route.entryProtocolConfig.protocol)) {
      throw new BadRequestException("This route's protocol is not allowed on your plan");
    }

    // Bring the rest up to date too, so a subscription created before a
    // route existed gains it the next time the customer touches the
    // picker rather than staying permanently short of options.
    await this.provisionAll(subscriptionId);

    const existing = await this.prisma.protocolUser.findFirst({
      where: { subscriptionId, routeId },
      include: { protocolConfig: { include: { node: true } } },
    });
    if (existing) {
      return {
        ...withDecryptedCredentials(existing),
        connection: connectionInfo(existing.protocolConfig.node, existing.protocolConfig),
      };
    }
    return this.create({ subscriptionId, routeId });
  }

  async remove(id: string) {
    const user = await this.getRaw(id);

    await this.agentGateway.enqueueCommand(user.nodeId, "DELETE_USER", {
      protocol: user.protocol,
      transport: user.protocolConfig.transport,
      ...targetInbound(user.protocolConfig),
      externalUserId: user.externalUserId,
    });

    await this.prisma.protocolUser.delete({ where: { id } });
  }

  async setEnabled(id: string, enabled: boolean) {
    const user = await this.getRaw(id);

    if (enabled) {
      // Re-enabling needs the original credentials back, not just a flag
      // flip -- see the SetEnabled contract in agent/internal/protocols/common.
      const credentials = decryptCredentials(user.credentialsJson);
      await this.agentGateway.enqueueCommand(user.nodeId, "ENABLE_USER", {
        protocol: user.protocol,
        transport: user.protocolConfig.transport,
        ...targetInbound(user.protocolConfig),
        externalUserId: user.externalUserId,
        credentials,
      });
    } else {
      await this.agentGateway.enqueueCommand(user.nodeId, "DISABLE_USER", {
        protocol: user.protocol,
        transport: user.protocolConfig.transport,
        ...targetInbound(user.protocolConfig),
        externalUserId: user.externalUserId,
      });
    }

    const updated = await this.prisma.protocolUser.update({
      where: { id },
      data: { status: enabled ? "ACTIVE" : "DISABLED" },
    });
    return withDecryptedCredentials(updated);
  }

  private async usedWireGuardAddresses(protocolConfigId: string): Promise<string[]> {
    const existing = await this.prisma.protocolUser.findMany({
      where: { protocolConfigId },
      select: { credentialsJson: true },
    });
    return existing
      .map((u) => decryptCredentials(u.credentialsJson).address)
      .filter((address): address is string => Boolean(address));
  }
}

/** credentialsJson is encrypted at rest (see credentials-crypto.ts) --
 * admin API responses still need to hand back the actual usable
 * credentials (that's the entire point of this endpoint existing: an
 * admin retrieves them to give to a customer), so every external-facing
 * read replaces the encrypted string with the decrypted object. Access
 * control is the existing admin JWT guard, unchanged. */
function withDecryptedCredentials<T extends { credentialsJson: string }>(
  user: T,
): Omit<T, "credentialsJson"> & { credentials: Record<string, string> } {
  const { credentialsJson, ...rest } = user;
  return { ...rest, credentials: decryptCredentials(credentialsJson) };
}

/** The server-side half of what a native client needs to build a working
 * tunnel: where to connect, plus the entry ProtocolConfig's public
 * parameters.
 *
 * Shared by every customer-facing path that hands back a ProtocolUser
 * (list, switch-route, trial grant) rather than living inline in one of
 * them. It used to be inline in listByCustomer only, which meant
 * switching servers returned a ProtocolUser with no `connection` -- the
 * app then had a credential set with no server address and failed at the
 * point of connecting, well away from the cause. Keeping one builder
 * means a new customer-facing endpoint can't quietly reintroduce that. */
/** Names the exact Xray inbound a command targets, when the config says
 * which one.
 *
 * Omitted entirely when null so the payload is byte-identical to what
 * every non-relay node has always received -- the agent reads an absent
 * tag as "the inbound you were started with", which is what every
 * existing config relies on.
 *
 * This matters most on the commands that are not create(). A relay runs
 * one inbound per exit, so removing or disabling a customer without
 * naming the inbound would act on the wrong listener: the credential
 * would keep working on the inbound it actually lives on, which for a
 * quota suspension or an account deletion means the customer is not
 * actually cut off.
 */
function targetInbound(protocolConfig: { inboundTag: string | null }): { inboundTag?: string } {
  return protocolConfig.inboundTag ? { inboundTag: protocolConfig.inboundTag } : {};
}

/** The publicParamsJson keys a client legitimately needs, per protocol.
 *
 * A whitelist rather than a blocklist, and deliberately so: this object
 * is handed to every customer, and it is not in fact all public. OpenVPN
 * stores its CA private key and the server's own key there, because the
 * backend signs client certificates and needs them. Returning the whole
 * object let any customer download the CA and sign themselves unlimited
 * client certificates -- access that would outlive their subscription
 * and survive their account being deleted, since nothing about it is
 * checked again after issuance.
 *
 * Anything not named here never reaches a client, so a key added to a
 * ProtocolConfig later is private by default rather than exposed by
 * omission. */
const CLIENT_VISIBLE_PUBLIC_PARAMS: Record<string, readonly string[]> = {
  XRAY_VLESS_REALITY: ["realityPublicKey", "shortIds", "dest", "serverName"],
  // Trojan's certificate is a real one for a real domain, and the client
  // verifies it with no allowInsecure escape hatch. So the domain has to
  // reach the client: without it the client falls back to the node's IP
  // as SNI, the certificate does not match that, and every connection
  // fails at the TLS handshake. The password is the customer's and lives
  // in credentials; the domain is the server's and lives here.
  XRAY_TROJAN: ["serverName"],
  // Same reasoning as Trojan: an ordinary certificate is verified against
  // a name, so the name has to travel. There is deliberately nothing
  // REALITY-shaped here -- no borrowed key, no shortId -- because this
  // variant presents a certificate of its own.
  //
  // `path` is only set when this config is carried over a WebSocket, and
  // it is not a secret: it is sent in the clear in the HTTP upgrade, so a
  // censor watching the connection already has it. It travels because the
  // client cannot guess it, and a mismatched path is answered by the
  // fallback web page rather than by the tunnel -- which looks to the
  // customer exactly like a server that is up but broken.
  XRAY_VLESS_TLS: ["serverName", "path"],
  // `serverKey` is the inbound's shared pre-shared key, and it does have
  // to reach the client: Shadowsocks 2022 authenticates with the server
  // key and the user's key together, so a customer holding only their
  // own half cannot connect. Sharing it is inherent to the multi-user
  // design rather than a leak -- it identifies the listener, while the
  // per-user key is what identifies and authorises the customer, and
  // revoking one customer means removing their key alone.
  SHADOWSOCKS: ["method", "serverKey"],
  // phantunTcpEndpoint is how a client reaches this tunnel on a network
  // that drops WireGuard outright. Measured on the Iran relay
  // 2026-08-14: a real handshake left the client and never arrived,
  // while TCP to the same node did -- so on those nodes `endpoint` is
  // unreachable and this is the address that works. Absent everywhere
  // else, and a client that does not understand it just uses `endpoint`
  // as before.
  WIREGUARD: ["serverPublicKey", "endpoint", "subnetCidr", "dns", "phantunTcpEndpoint"],
  // caCertPem is genuinely needed to verify the server, and already
  // travels in the per-user credentials. caKeyPem and serverKeyPem are
  // the secrets and are absent on purpose.
  OPENVPN: ["endpoint", "proto", "tlsCryptKey"],
  // The hostname, and only the hostname. Both platform clients validate
  // the node's certificate against whatever address they dialled and
  // neither can be told a remote identity separately, so without this
  // the client has only the node's IP -- which no certificate names.
  //
  // `pool` and `auth` stay behind: the address pool is the server's own
  // business, and the authentication method is already implied by the
  // credentials being a username and a password.
  IKEV2: ["endpointHost"],
};

function connectionInfo(
  node: { publicIp: string },
  protocolConfig: {
    protocol: string;
    listenPort: number;
    publicParamsJson: unknown;
    transport?: string;
    security?: string;
  },
) {
  const allowed = CLIENT_VISIBLE_PUBLIC_PARAMS[protocolConfig.protocol] ?? [];
  const source = (protocolConfig.publicParamsJson ?? {}) as Record<string, unknown>;
  const publicParams: Record<string, unknown> = {};
  for (const key of allowed) {
    if (source[key] !== undefined) {
      publicParams[key] = source[key];
    }
  }

  return {
    host: node.publicIp,
    port: protocolConfig.listenPort,
    // How to carry it, and what to wrap it in. Without these a client
    // holding a VLESS credential has no way to tell a plain TLS inbound
    // from a WebSocket one -- the Protocol member is the same for both,
    // deliberately, and guessing wrong fails the handshake.
    //
    // Defaulted rather than required so a client keeps working against a
    // node whose row predates these columns.
    transport: protocolConfig.transport ?? "TCP",
    security: protocolConfig.security ?? "NONE",
    publicParams,
  };
}
