import { BadRequestException, Injectable, Logger, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { Prisma, Protocol } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { ListWindow, Page } from "../../common/pagination";
import { after, forEachBatch } from "../../common/batching";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.service";
import { SESSION_IDLE_LIFETIME_MS } from "../customer-auth/session-lifetime";
import { decryptCredentials, encryptCredentials } from "./credentials-crypto";
import { CreateProtocolUserDto } from "./dto/create-protocol-user.dto";
import { rateLimitFor } from "./rate-limit";
import { generateCredentials } from "./generate-credentials";
import { KeyedLock } from "./keyed-lock";
import { commandTarget, deleteUserPayload } from "./command-target";
import { sharedWireGuardReserve, wireGuardPoolSize } from "./wireguard-subnet";

/** How many signed-in devices of one customer may hold credentials of
 * their own at once. See `enforceDeviceLimit`.
 *
 * Five by default: a phone, a laptop, a tablet and a spare, with room
 * for a reinstall before the oldest is evicted. The ceiling it protects
 * is the node's, not the customer's -- a WireGuard config serves a /24,
 * 253 peers, and every device credential is one of them. Read at call
 * time so a test or an operator can change it without a rebuild. */
export function deviceCredentialLimit(): number {
  const raw = Number(process.env.CUSTOMER_DEVICE_CREDENTIAL_LIMIT);
  return Number.isInteger(raw) && raw >= 1 ? raw : 5;
}

/** How many devices of one customer may receive their first credential
 * set within DEVICE_SET_WINDOW_MS. See allowNewDeviceSet. Ten an hour is
 * far above anyone signing in on their own devices -- reinstalls
 * included -- and far below a loop. */
const NEW_DEVICE_SETS_PER_WINDOW = 10;
const DEVICE_SET_WINDOW_MS = 60 * 60 * 1000;

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
  // Which device a credential belongs to, or null for the shared one --
  // the first thing an operator needs when a customer says "my other
  // phone stopped working".
  sessionId: true,
  // Whether a node has confirmed holding it -- the second thing.
  provisionedAt: true,
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

  /** Device provisioning and revocation, one at a time per customer:
   * keeps two fetches from one device from both creating a set, and a
   * sign-out from interleaving with a fetch still creating one. */
  private readonly customerLock = new KeyedLock();
  /** WireGuard address allocation, one at a time per config. It reads
   * the addresses in use and then inserts, so two concurrent creations
   * could pick the same one -- and two peers on one address break the
   * older. provisionAll avoided that by being sequential; lazy device
   * provisioning makes concurrent creation an ordinary event. */
  private readonly wireGuardLock = new KeyedLock();
  /** When each customer recently started a device's first set -- see
   * allowNewDeviceSet. */
  private readonly newDeviceSets = new Map<string, number[]>();

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
    // The shared credentials only. Device credentials belong to one
    // signed-in device each, and handing every device's set to a caller
    // that named no device would undo the point of having them.
    const users = await this.prisma.protocolUser.findMany({
      where: { subscription: { customerId }, sessionId: null },
      orderBy: { createdAt: "desc" },
      include: { node: true, protocolConfig: true },
    });
    return users.map(({ node, protocolConfig, ...user }) => ({
      ...withDecryptedCredentials(user),
      connection: connectionInfo(node, protocolConfig),
    }));
  }

  /** Customer-facing: the credentials for one signed-in device.
   *
   * What `GET /customer/protocol-users` answers. With no session -- an
   * access token from before sessions existed -- it is `listByCustomer`,
   * unchanged. With one, the device is first given credentials of its
   * own on every route its ACTIVE subscriptions allow (see
   * `ensureDeviceCredentials`), and the answer is those, with any gap
   * filled by the shared credential for the same subscription and route.
   *
   * The gap-filling is what makes this safe to ship. A route where the
   * device's own credential could not be created -- a WireGuard pool
   * that is full, a config missing its parameters -- and a subscription
   * that is not ACTIVE, for which none are created, both answer exactly
   * what they answered before this existed. The response shape is the
   * same either way, so clients need no change: they replace their
   * cached list on every fetch and clear it on sign-out already.
   *
   * A session that is revoked, gone, or someone else's is refused with
   * 401. Access tokens live fifteen minutes and are not checked against
   * the session table, so without this a device that had just signed out
   * could mint itself a fresh set with the token it still held.
   */
  async listForDevice(customerId: string, sessionId: string | undefined) {
    if (!sessionId) return this.listByCustomer(customerId);

    return this.customerLock.run(customerId, async () => {
      await this.assertLiveSession(customerId, sessionId);
      await this.ensureDeviceCredentials(customerId, sessionId);
      return this.deviceView(customerId, sessionId);
    });
  }

  private async assertLiveSession(customerId: string, sessionId: string) {
    const session = await this.prisma.customerSession.findFirst({
      where: { id: sessionId, customerId },
      select: { revokedAt: true },
    });
    if (!session || session.revokedAt) {
      throw new UnauthorizedException("This device has been signed out");
    }
  }

  /** Gives one device a credential of its own on every route each of the
   * customer's ACTIVE subscriptions can be provisioned on now -- the same
   * set provisionAll gives the shared credential.
   *
   * Only ACTIVE subscriptions. A suspended or expired one has its
   * credentials switched off on the nodes, and creating a fresh, enabled
   * one for whoever asks would undo the suspension. The status is read
   * again after creating, for the same reason: a subscription suspended
   * while this ran gets the new rows switched off too.
   *
   * A failure on one route is logged and skipped, not thrown. The device
   * then gets the shared credential for that route (see listForDevice),
   * which is what it had yesterday -- far better than a customer with
   * nothing to connect with because one node's config was incomplete.
   *
   * Runs under the customer lock; must not take it again.
   */
  private async ensureDeviceCredentials(customerId: string, sessionId: string) {
    const subscriptions = await this.prisma.subscription.findMany({
      // And only for an account that is itself ACTIVE: a disabled one
      // must not be able to mint fresh credentials by fetching.
      where: { customerId, status: "ACTIVE", customer: { status: "ACTIVE" } },
      select: {
        id: true,
        plan: { select: { name: true, protocolsAllowed: true, allowedRoutes: { select: { id: true } } } },
      },
    });
    if (subscriptions.length === 0) return;

    const held = await this.prisma.protocolUser.findMany({
      where: { sessionId },
      select: { subscriptionId: true, routeId: true },
    });
    if (held.length === 0) {
      // A device's first set. Rate-limited first, so a refused set
      // evicts nobody; then make room before creating it.
      if (!this.allowNewDeviceSet(customerId)) return;
      await this.enforceDeviceLimit(customerId, sessionId);
    }
    const heldKeys = new Set(held.map((u) => `${u.subscriptionId}:${u.routeId}`));

    for (const subscription of subscriptions) {
      const { routes } = await this.routesFor(subscription.plan);
      const created: string[] = [];
      for (const route of routes) {
        if (heldKeys.has(`${subscription.id}:${route.id}`)) continue;
        try {
          const user = await this.create({ subscriptionId: subscription.id, routeId: route.id }, sessionId);
          created.push(user.id);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `Device credential not created (session ${sessionId}, subscription ${subscription.id}, ` +
              `route ${route.id}); the device falls back to the shared credential: ${reason}`,
          );
        }
      }
      if (created.length === 0) continue;

      const now = await this.prisma.subscription.findUnique({
        where: { id: subscription.id },
        select: { status: true },
      });
      if (now?.status !== "ACTIVE") {
        // One at a time and each on its own: a row that has gone in the
        // meantime must not leave the ones after it switched on.
        for (const id of created) {
          await this.setEnabled(id, false).catch((err: unknown) =>
            this.logger.warn(
              `Could not switch off device credential ${id} of a subscription no longer ACTIVE: ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
          );
        }
      }
    }
  }

  /** Whether this customer may start another device's first credential
   * set now, counting it if so.
   *
   * The device cap bounds how many sets exist at once, not how fast they
   * are made and thrown away. Past the cap every new session's first
   * fetch evicts the oldest device (DELETE_USER on every route) and
   * creates a full set (CREATE_USER on every route) -- each an OpenVPN
   * RSA keygen on this process's event loop, a ccd file that is never
   * cleaned up, an IKEv2 secrets reload, an agent_commands row. A
   * sign-in loop (login, social, or until about 2026-10-12 a replayed
   * sid-less refresh token, which opens a new session on every call) had
   * no ceiling on that rate.
   *
   * Refusing costs the device nothing it had before: with no set of its
   * own it is handed the subscription's shared credentials, exactly what
   * every device got before per-device credentials existed. In-process,
   * like the customer lock, on the same one-instance assumption. */
  private allowNewDeviceSet(customerId: string, now = Date.now()): boolean {
    const recent = (this.newDeviceSets.get(customerId) ?? []).filter((at) => now - at < DEVICE_SET_WINDOW_MS);
    if (recent.length >= NEW_DEVICE_SETS_PER_WINDOW) {
      this.newDeviceSets.set(customerId, recent);
      this.logger.warn(
        `Customer ${customerId} has started ${recent.length} device credential sets within the hour; ` +
          `this device gets the shared credentials instead`,
      );
      return false;
    }
    recent.push(now);
    this.newDeviceSets.set(customerId, recent);
    // Housekeeping, so the map holds customers active this hour rather
    // than every customer since the process started.
    if (this.newDeviceSets.size > 1000) {
      for (const [key, times] of this.newDeviceSets) {
        if (times.every((at) => now - at >= DEVICE_SET_WINDOW_MS)) this.newDeviceSets.delete(key);
      }
    }
    return true;
  }

  /** Keeps the number of devices holding credentials of their own at or
   * below `deviceCredentialLimit()`, by taking them back from the device
   * least recently refreshed.
   *
   * Evicting rather than refusing, because the device being refused is
   * the one the customer is holding right now, while the one evicted is
   * most often a reinstall's abandoned session. An evicted device that is
   * in fact still in use gets a fresh set on its next fetch; only past
   * the limit in *active* devices does this churn, and then the cost is
   * a reconnect, not an outage.
   *
   * The limit exists for the nodes. Each device credential is a peer, an
   * EAP identity or a client in an engine, and a sign-in loop could
   * otherwise create them without bound -- a WireGuard config has 253
   * addresses. */
  private async enforceDeviceLimit(customerId: string, sessionId: string) {
    const holders = await this.prisma.customerSession.findMany({
      where: { customerId, id: { not: sessionId }, protocolUsers: { some: {} } },
      select: { id: true },
      orderBy: { lastUsedAt: "asc" },
    });
    const excess = holders.length - (deviceCredentialLimit() - 1);
    for (const holder of holders.slice(0, Math.max(0, excess))) {
      this.logger.log(
        `Customer ${customerId} is at the device limit; taking credentials back from session ${holder.id}`,
      );
      await this.removeSessionCredentials(holder.id);
    }
  }

  /** The device's own rows, with each gap filled by the shared row for the
   * same subscription and route.
   *
   * A device row counts as the device's only once a node has confirmed
   * it holds it (`provisionedAt`). Until then the device keeps the shared
   * credential for that route, which already works. Creating the row and
   * enqueueing its CREATE_USER is not the same as the node having it: a
   * node whose control stream is down leaves the command QUEUED -- for
   * days, on the nodes that have done this -- while still serving the
   * users it already holds, and even a connected node runs commands one
   * at a time behind the re-assert backlog. Handing the device its new
   * credential at that point made it swap a working tunnel for one that
   * could not connect, on every route of that node at once, and the
   * client dials whatever it was handed straight away.
   *
   * Gated rather than offering both, the device's first: a client keys
   * its credentials by route and would not necessarily try a second one
   * for the same route, and a failed dial costs a timeout and a wrong
   * entry in the per-ISP evidence. Gated, the response keeps its shape --
   * one credential per route, and one that works.
   *
   * A device row with no shared row beside it is handed out unconfirmed:
   * there is nothing that works to keep. */
  private async deviceView(customerId: string, sessionId: string) {
    const users = await this.prisma.protocolUser.findMany({
      where: { subscription: { customerId }, OR: [{ sessionId }, { sessionId: null }] },
      orderBy: { createdAt: "desc" },
      include: { node: true, protocolConfig: true },
    });
    const keyOf = (u: { subscriptionId: string; routeId: string }) => `${u.subscriptionId}:${u.routeId}`;
    // One shared row per (subscription, route): the oldest. There is
    // normally exactly one, but a rollback to a backend that knew nothing
    // of devices can leave more -- its session pruning sets a device row's
    // sessionId to NULL (the foreign key's SET NULL) -- and a client
    // handed two credentials for one route would have to guess.
    const sharedFor = new Map<string, (typeof users)[number]>();
    for (const u of users) {
      if (u.sessionId !== null) continue;
      const seen = sharedFor.get(keyOf(u));
      if (!seen || u.createdAt < seen.createdAt) sharedFor.set(keyOf(u), u);
    }
    const own = new Set(
      users
        .filter((u) => u.sessionId === sessionId && (u.provisionedAt !== null || !sharedFor.has(keyOf(u))))
        .map(keyOf),
    );
    // Filtered again here although the query already excludes them:
    // another device's credential reaching this response would be the one
    // failure this whole design exists to prevent.
    return users
      .filter((u) => {
        if (u.sessionId === sessionId) return own.has(keyOf(u));
        return u.sessionId === null && !own.has(keyOf(u)) && sharedFor.get(keyOf(u)) === u;
      })
      .map(({ node, protocolConfig, ...user }) => ({
        ...withDecryptedCredentials(user),
        connection: connectionInfo(node, protocolConfig),
      }));
  }

  /** Takes back every credential one signed-in device holds, on every
   * node: what signing out does, after the session itself is revoked.
   * The customer's other devices, and the shared credentials, are not
   * touched.
   *
   * `customerId` scopes it, so a caller can only ever revoke its own
   * customer's devices.
   *
   * Never throws for a credential the node could not be told about: that
   * row is left in place, logged, and counted in `failed`, and the hourly
   * sweep tries again. A sign-out must not fail because a node is down.
   */
  async revokeSessionCredentials(customerId: string, sessionId: string) {
    return this.customerLock.run(customerId, () => this.removeSessionCredentials(sessionId, customerId));
  }

  /** Runs work with no device provisioning or revocation for this
   * customer in flight, and none starting until it is done.
   *
   * For deleting an account. Device credentials are created lazily, on a
   * plain GET, so a fetch landing between deletion's read of the rows and
   * its transaction either inserted a row that was then deleted without
   * any DELETE_USER -- a live credential on the node with nothing in the
   * database -- or, after the commit, minted ACTIVE credentials on a
   * CANCELLED subscription for a session nothing had revoked. Under the
   * lock a fetch either finishes first (and its rows are read and
   * removed) or starts after, and finds the session revoked or gone.
   *
   * `work` must not call anything here that takes the lock itself
   * (revokeSessionCredentials, endSessions, listForDevice): KeyedLock is
   * not re-entrant. */
  withCustomerLock<T>(customerId: string, work: () => Promise<T>): Promise<T> {
    return this.customerLock.run(customerId, work);
  }

  /** Ends sessions in bulk and takes their device credentials back -- for
   * a password reset or change, where every other device is meant to stop
   * working. `except` keeps the caller's own session (a password change
   * from a signed-in device should not drop that device's tunnel).
   *
   * Revoked first, credentials second, so a failure in between leaves the
   * sessions unusable and the sweep to finish the job. */
  async endSessions(customerId: string, except?: string) {
    const where: Prisma.CustomerSessionWhereInput = {
      customerId,
      revokedAt: null,
      ...(except ? { id: { not: except } } : {}),
    };
    await this.prisma.customerSession.updateMany({ where, data: { revokedAt: new Date() } });

    const holders = await this.prisma.customerSession.findMany({
      where: { customerId, protocolUsers: { some: {} }, ...(except ? { id: { not: except } } : {}) },
      select: { id: true },
    });
    let revoked = 0;
    for (const holder of holders) {
      revoked += (await this.revokeSessionCredentials(customerId, holder.id)).revoked;
    }
    return { sessions: holders.length, revoked };
  }

  /** Runs under the customer lock (or from a path that already holds it). */
  private async removeSessionCredentials(sessionId: string, customerId?: string) {
    const users = await this.prisma.protocolUser.findMany({
      where: { sessionId, ...(customerId ? { subscription: { customerId } } : {}) },
      select: { id: true },
    });
    let revoked = 0;
    let failed = 0;
    for (const user of users) {
      try {
        await this.remove(user.id);
        revoked += 1;
      } catch (err) {
        failed += 1;
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.error(`Could not revoke device credential ${user.id} (session ${sessionId}): ${reason}`);
      }
    }
    return { revoked, failed };
  }

  /** Reclaims the credentials of devices that are gone, and then their
   * session rows.
   *
   * A session's credentials are taken back when it was signed out (and
   * the sign-out could not finish -- a node was unreachable, or the
   * sessions were ended in bulk), or when it is idle: neither refreshed
   * nor carrying any traffic for SESSION_IDLE_LIFETIME_MS.
   *
   * Traffic counts as use on purpose. A refresh token lives a week, and a
   * device goes on connecting with the credentials it holds long after
   * that -- an always-on phone tunnel nobody opens the app on, or a
   * client whose control plane is filtered while the nodes are not.
   * Judging by refreshes alone would cut those devices off a month in,
   * and they are the ones the offline credential cache exists for.
   *
   * Cursored like every other sweep; candidates still in use stay
   * behind the cursor rather than holding up the page.
   */
  async sweepDeadSessionCredentials(now = new Date()) {
    const cutoff = new Date(now.getTime() - SESSION_IDLE_LIFETIME_MS);
    let sessions = 0;
    let revoked = 0;
    let failed = 0;

    await forEachBatch({
      label: "sweepDeadSessionCredentials",
      read: (afterId, take) =>
        this.prisma.customerSession.findMany({
          where: {
            protocolUsers: { some: {} },
            OR: [{ revokedAt: { not: null } }, { lastUsedAt: { lt: cutoff } }],
            ...after(afterId),
          },
          select: { id: true, customerId: true, revokedAt: true },
          orderBy: { id: "asc" },
          take,
        }),
      handle: async (batch) => {
        for (const session of batch) {
          if (!session.revokedAt) {
            const recent = await this.prisma.usageRecord.findFirst({
              where: { protocolUser: { is: { sessionId: session.id } }, reportedAt: { gte: cutoff } },
              select: { id: true },
            });
            if (recent) continue;
          }
          const result = await this.revokeSessionCredentials(session.customerId, session.id);
          revoked += result.revoked;
          failed += result.failed;
          sessions += 1;
          if (result.failed === 0) {
            // Gone from the nodes, so the row can go too -- the same pruning
            // sign-in does for sessions that never held credentials.
            await this.prisma.customerSession.deleteMany({
              where: { id: session.id, protocolUsers: { none: {} } },
            });
          }
        }
      },
    });

    if (sessions > 0) {
      this.logger.log(
        `Device credential sweep: revoked ${revoked} credential(s) across ${sessions} dead session(s)` +
          (failed > 0 ? `, ${failed} failed and will be retried` : ""),
      );
    }
    return { sessions, revoked, failed };
  }

  /** Internal callers (setEnabled, remove) need the raw encrypted row,
   * not the decrypted API-response shape get() returns. */
  private async getRaw(id: string) {
    const user = await this.prisma.protocolUser.findUnique({
      where: { id },
      // The config comes along so remove/setEnabled can name the same
      // listener create() used. Without it they send only the protocol,
      // which stopped identifying an inbound once one node could serve
      // the same protocol on two of them -- see command-target.ts.
      include: { protocolConfig: { select: { transport: true, inboundTag: true } } },
    });
    if (!user) {
      throw new NotFoundException("Protocol user not found");
    }
    return user;
  }

  /** `sessionId` makes it a device credential (see ProtocolUser.sessionId);
   * omitted, it is the subscription's shared one, as it always was. */
  async create(dto: CreateProtocolUserDto, sessionId?: string) {
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
    // A device credential is only ever made for a live subscription. The
    // caller checked, but a suspension, an expiry or an account deletion
    // can land in between, and an enabled credential minted after it
    // would undo it.
    if (sessionId && subscription.status !== "ACTIVE") {
      throw new BadRequestException("Subscription is not active");
    }

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

    // Allocation and insert together under the config's lock, so the
    // address read as free is still free when the row claiming it lands.
    const insert = async () => {
      const usedAddresses =
        protocolConfig.protocol === "WIREGUARD" ? await this.usedWireGuardAddresses(protocolConfig.id) : [];

      // A device credential may not take the last addresses of a pool:
      // those are kept for shared credentials, which have nothing to fall
      // back to (see sharedWireGuardReserve). Refusing here sends the
      // device back to its subscription's shared credential, the same as
      // any other failure to create one.
      if (sessionId && protocolConfig.protocol === "WIREGUARD") {
        const cidr = (protocolConfig.publicParamsJson as { subnetCidr?: unknown } | null)?.subnetCidr;
        const pool = typeof cidr === "string" ? wireGuardPoolSize(cidr) : null;
        if (pool !== null && pool - usedAddresses.length <= sharedWireGuardReserve(pool)) {
          throw new BadRequestException(
            `WireGuard pool ${String(cidr)} is down to the addresses kept for subscription credentials`,
          );
        }
      }

      const generated = generateCredentials(protocolConfig.protocol, protocolConfig, usedAddresses);

      const row = await this.prisma.protocolUser.create({
        data: {
          subscriptionId: dto.subscriptionId,
          routeId: dto.routeId,
          nodeId: protocolConfig.nodeId,
          protocolConfigId: protocolConfig.id,
          protocol: protocolConfig.protocol,
          externalUserId: generated.externalUserId,
          credentialsJson: encryptCredentials(generated.credentials),
          ...(sessionId ? { sessionId } : {}),
        },
      });
      return { ...generated, protocolUser: row };
    };
    const { externalUserId, credentials, protocolUser } =
      protocolConfig.protocol === "WIREGUARD"
        ? await this.wireGuardLock.run(protocolConfig.id, insert)
        : await insert();

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
      ...commandTarget(protocolConfig),
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
    // Every row of the subscription, shared and per-device alike: what
    // the plan no longer allows is revoked from every device, not only
    // from the shared set.
    const [{ routes, allowedRouteIds }, existing] = await Promise.all([
      this.routesFor(subscription.plan),
      this.prisma.protocolUser.findMany({
        where: { subscriptionId },
        select: { id: true, routeId: true, sessionId: true },
      }),
    ]);

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
    //
    // The shared set only. A device's own credentials are added when that
    // device next fetches (listForDevice), which it does before every
    // connect once its list is ten minutes old -- so a new route reaches
    // every device without this having to know which devices exist.
    const already = new Set(
      existing.filter((u) => !u.sessionId && allowedRouteIds.has(u.routeId)).map((u) => u.routeId),
    );
    const created = [];
    const failed: { routeId: string; reason: string }[] = [];
    for (const route of routes) {
      if (already.has(route.id)) continue;
      // Sequential, not Promise.all: WireGuard address allocation reads
      // the addresses already in use, so two routes on the same node
      // provisioned in parallel can pick the same one.
      //
      // One route failing must not cost the customer the others. This
      // runs on a confirmed payment, a renewal, a trial grant and a
      // voucher, and a throw here -- a WireGuard pool with no free
      // address left is the one in sight -- used to abort every route
      // that sorted after the failing one, and with them the caller's
      // own remaining work (the invoice after a renewal). Logged at
      // error, because a paying customer short of a route is not routine.
      try {
        created.push(await this.create({ subscriptionId, routeId: route.id }));
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        failed.push({ routeId: route.id, reason });
        this.logger.error(`provisionAll(${subscriptionId}): route ${route.id} could not be provisioned: ${reason}`);
      }
    }

    // Every half, named. This used to return the created users alone,
    // which was the whole story when it could only add -- and once it
    // could also revoke, every caller was structurally unable to see
    // that half. The backfill in particular summarised a sweep as
    // "added N" while the same sweep deleted credentials from live
    // nodes. Returning one array again would rebuild that blind spot.
    return { created, revoked, failed };
  }

  /** The routes a plan can be provisioned on now (`routes`, enabled and
   * reachable, ordered by name), and the ones it allows at all
   * (`allowedRouteIds`, ignoring whether they are up -- only revocation
   * reads it). Shared by provisionAll and device provisioning so the two
   * can never disagree about what a plan includes.
   *
   * Two queries rather than one broader one, so each answers exactly one
   * of those questions and neither has to be read as also meaning the
   * other. */
  private async routesFor(plan: { protocolsAllowed: Protocol[]; allowedRoutes: { id: string }[] }) {
    const selectionFilter = { id: { in: plan.allowedRoutes.map((r) => r.id) } };
    const [routes, allowedByPolicy] = await Promise.all([
      this.prisma.route.findMany({
        where: {
          isEnabled: true,
          ...selectionFilter,
          entryProtocolConfig: { protocol: { in: plan.protocolsAllowed }, isEnabled: true },
        },
        select: { id: true },
        orderBy: { name: "asc" },
      }),
      this.prisma.route.findMany({
        where: {
          ...selectionFilter,
          entryProtocolConfig: { protocol: { in: plan.protocolsAllowed } },
        },
        select: { id: true },
      }),
    ]);
    return { routes, allowedRouteIds: new Set(allowedByPolicy.map((r) => r.id)) };
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
  async switchRoute(subscriptionId: string, routeId: string, sessionId?: string) {
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

    // A signed-in device gets its own credential for the route, by the
    // same path as its credential list -- including the fallback to the
    // shared one if its own could not be made.
    if (sessionId) {
      const mine = (await this.listForDevice(subscription.customerId, sessionId)).find(
        (u) => u.subscriptionId === subscriptionId && u.routeId === routeId,
      );
      if (mine) return mine;
    }

    const existing = await this.prisma.protocolUser.findFirst({
      where: { subscriptionId, routeId, sessionId: null },
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

    await this.agentGateway.enqueueCommand(user.nodeId, "DELETE_USER", deleteUserPayload(user, user.protocolConfig));

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
        ...commandTarget(user.protocolConfig),
        externalUserId: user.externalUserId,
        credentials,
      });
    } else {
      await this.agentGateway.enqueueCommand(user.nodeId, "DISABLE_USER", {
        protocol: user.protocol,
        ...commandTarget(user.protocolConfig),
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
