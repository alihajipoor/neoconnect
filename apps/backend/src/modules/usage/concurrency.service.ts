import { forwardRef, Inject, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.service";
import { commandTarget } from "../protocol-users/command-target";
import {
  DevicePresence,
  DeviceKey,
  SHARED_DEVICE,
  deviceKeyOf,
  resolveDevices,
  sessionIdOf,
} from "../device-slots/device-presence";
import { concurrencyCutMode } from "../device-slots/modes";
import { DISPLACED_GRACE_MS, DeviceSlotsService, type SlotGrant } from "../device-slots/device-slots.service";
import type { UsageDeltaInput } from "./usage.service";

export interface SessionCountInput {
  externalUserId: string;
  protocol: string;
  distinctSources: number;
}

/** A device counts as active while one of its credentials has been seen
 * carrying traffic this recently. One and a half report cycles (nodes
 * report every ~30 s): long enough that a device reporting every cycle
 * never drops out between two reports, short enough that a device which
 * has just disconnected stops counting within a cycle -- which is what
 * keeps a clean switch from the PC to the phone from looking like two
 * devices for long enough to collect STRIKES_BEFORE_ACTION. */
export const PRESENCE_FRESH_MS = 45_000;

/** Readings over the limit in a row before anything is done.
 *
 * A single over-limit reading is not evidence of sharing: moving from
 * the PC to the phone, or from wifi to mobile data, briefly shows both.
 * Three readings at least MIN_STRIKE_GAP_MS apart is about a minute of
 * sustained overlap. */
const STRIKES_BEFORE_ACTION = 3;

/** The shortest gap between two strikes against one subscription.
 *
 * Several nodes report the same subscription independently; five nodes
 * would otherwise land three strikes in a few seconds and act on what is
 * still a single reading. Twenty seconds is comfortably inside the ~30 s
 * report interval, so an honest cycle still counts and a burst counts
 * once. */
const MIN_STRIKE_GAP_MS = 20_000;

/** How long one hold lasts unless extended. Evaluation extends every
 * hold of a subscription for as long as the devices not held leave no
 * room; once nothing extends it, it lapses and the next 60 s re-assert
 * puts the credentials back. So a held device is back within about two
 * and a half minutes of the other device going quiet, with no control
 * plane needed on its side. */
export const HOLD_LEASE_MS = 90_000;

/** "Would hold" lines per subscription in shadow mode: at most one per
 * this interval, so a subscription persistently over its limit does not
 * log every ninety seconds forever. */
const SHADOW_LOG_INTERVAL_MS = 10 * 60_000;

/** Engines whose session count carries a tail, and is ignored here: for
 * these a device is active only while its usage report shows bytes.
 *
 * WireGuard counts a peer for three minutes after its last handshake.
 * Xray's counter (one per inbound, all reading the access log) counts a
 * source for 60 s after its last "accepted" line. Either tail made a
 * clean switch look like two devices for long enough to be held -- and
 * the device held was the newest, the one the customer had just switched
 * to: a PC that opened a connection at t=20 s and disconnected at 25 s
 * was still "active" at 30, 60 and 90 alongside the phone, three strikes.
 * A WireGuard keepalive every 25 s puts bytes in every report anyway; an
 * Xray device shows while it carries traffic, which errs towards
 * counting fewer devices, never more.
 *
 * IKEv2's count has a tail with no end: strongSwan keeps an SA until
 * charon restarts (the connection sets rekey_time = 0s and no DPD), so a
 * phone that died or a PC that slept on IKEv2 stays listed. The sample
 * captured from a node on 2026-10-06 has two, about 21 hours old and
 * silent since their first minute. The agent this shipped with counts
 * only SAs that have had a packet in the last three minutes, but the
 * count is still not trusted here: an agent that counts every listed SA
 * would keep a device slot for a phone that is gone, indefinitely. Its bytes are
 * used instead. (Agents up to v0.2.9 report no IKEv2 sessions or usage at
 * all -- their parser matched nothing -- so this changes nothing for
 * them.)
 *
 * OpenVPN's count is the connections open right now, with no tail, and
 * still counts. Every protocol Xray serves on a node is listed
 * (Shadowsocks among them); see XRAY_SERVED_ON_NODE in the agent
 * gateway. */
const COUNTS_IGNORED = new Set([
  "WIREGUARD",
  "IKEV2",
  "XRAY_VLESS_REALITY",
  "XRAY_VLESS_TLS",
  "XRAY_VMESS",
  "XRAY_TROJAN",
  "SHADOWSOCKS",
]);

/** The plan's device limit, judged per device on what the nodes report.
 *
 * This is the backstop. The rule itself -- "if the PC is using the VPN,
 * the phone cannot at the same time on a plan with a limit of 1" -- is
 * enforced up front by device slots, which the apps claim before
 * connecting (docs/device-slots.md). This covers what slots cannot: a
 * client that does not claim (an old release, credentials copied into a
 * third-party app).
 *
 * Per device, not per credential or per source address: every
 * credential a signed-in device holds (ProtocolUser.sessionId) counts as
 * that one device, on however many routes and nodes -- concurrent exits
 * included -- and every shared credential counts together as one
 * pseudo-device (see resolveDevices for how shared traffic is attributed
 * during the transition).
 *
 * It replaces a subscription-wide cut that summed source addresses over
 * every credential and disconnected all of them for 60 s. That cut had
 * never been seen working; it counted every Xray user five times (one
 * counter per inbound, all reading the same log), it cut the device that
 * should have kept working along with the one that should not, a re-assert
 * undid it within a minute, and its restore replayed a captured list --
 * bringing back credentials revoked in the meantime. Combined with
 * per-device credentials it would also have disconnected customers who
 * were only switching devices, because WireGuard and OpenVPN no longer
 * make two devices fight over one key.
 *
 * Runs in SHADOW mode by default (CONCURRENCY_CUT): it decides, and logs
 * who it would hold, and sends nothing. See modes.ts. Nothing here has
 * been observed against a real node.
 */
@Injectable()
export class ConcurrencyService {
  private readonly logger = new Logger(ConcurrencyService.name);

  /** Consecutive over-limit readings per subscription. In memory on
   * purpose: a debounce, not a record. A restart costs a couple of extra
   * cycles before a real sharer trips it again. */
  private readonly strikes = new Map<string, number>();
  private readonly lastStrikeAt = new Map<string, number>();
  /** Last "would hold" line per subscription, in shadow mode. */
  private readonly lastShadowLogAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    // UsageModule and AgentGatewayModule import each other, so the
    // parameter needs its own forwardRef as well as the module-level one.
    @Inject(forwardRef(() => AgentGatewayService))
    private readonly agentGateway: AgentGatewayService,
    private readonly presence: DevicePresence,
    private readonly slots: DeviceSlotsService,
  ) {
    // A device let in through its app is never held, including by a hold
    // that came before it claimed: the device the backstop cut for being
    // over the limit is often the very one the customer then chooses with
    // "Use on this device instead".
    this.slots.onGrant((grant) => this.liftOnGrant(grant));
  }

  /** Lifts any hold on the credentials of a device that was just granted
   * a slot -- its own, and the shared credential it named -- and puts
   * them back on their nodes at once, since the app dials as soon as the
   * grant arrives. Without this the hold outlived the grant: the device
   * the customer had just chosen stayed off its nodes, its client ran the
   * ladder across every route on a dead tunnel, and the lease was renewed
   * for as long as the device it displaced kept going. */
  private async liftOnGrant(grant: SlotGrant) {
    const rows = await this.prisma.protocolUser.findMany({
      where: { subscriptionId: grant.subscriptionId, heldUntil: { gt: new Date() } },
      select: { id: true, sessionId: true },
    });
    const ids = rows.filter((r) => r.sessionId === grant.sessionId || r.id === grant.protocolUserId).map((r) => r.id);
    await this.lift(grant.subscriptionId, ids);
  }

  private async lift(subscriptionId: string, ids: string[]) {
    if (ids.length === 0) return;
    await this.prisma.protocolUser.updateMany({ where: { id: { in: ids } }, data: { heldUntil: null } });
    await this.agentGateway.reassertCredentials(ids);
    this.logger.warn(
      `Subscription ${subscriptionId}: lifted the hold on ${ids.length} credential(s) of a device holding a slot`,
    );
  }

  /** One node's stats report: records which credentials carried traffic,
   * then judges each subscription that appeared in it.
   *
   * Never throws. It runs inside the agent's stream handler, where an
   * exception closes the node's control stream -- and nothing about
   * counting devices is worth that. */
  async handleReport(nodeId: string, report: { sessions?: SessionCountInput[]; deltas?: UsageDeltaInput[] }) {
    try {
      await this.process(nodeId, report.sessions ?? [], report.deltas ?? [], Date.now());
    } catch (err) {
      this.logger.warn(`Device-limit evaluation for node ${nodeId} failed: ${(err as Error).message}`);
    }
  }

  private async process(nodeId: string, sessions: SessionCountInput[], deltas: UsageDeltaInput[], now: number) {
    // Session counts collapsed to the max per credential, from engines
    // whose count has no tail (COUNTS_IGNORED). Summing them is what once
    // made one phone on REALITY five devices: every Xray inbound has its
    // own counter reading the same access log.
    const counted = new Map<string, number>();
    for (const count of sessions) {
      // On the protocol, not the label: agents up to v0.2.9 send the
      // VLESS WebSocket inbound's counts as "XRAY_VLESS_TLS|WS", which an
      // exact match let through -- and with it Xray's tail, every poll.
      if (COUNTS_IGNORED.has(count.protocol.split("|")[0])) continue;
      counted.set(count.externalUserId, Math.max(counted.get(count.externalUserId) ?? 0, count.distinctSources));
    }
    const active = new Set([...counted].filter(([, n]) => n > 0).map(([id]) => id));
    for (const delta of deltas) {
      if (bytes(delta.bytesUp) + bytes(delta.bytesDown) > 0n) active.add(delta.externalUserId);
    }
    if (active.size === 0) return;

    const rows = await this.prisma.protocolUser.findMany({
      where: { nodeId, externalUserId: { in: [...active] } },
      select: { id: true, status: true, subscriptionId: true, sessionId: true },
    });

    const bySubscription = new Map<string, { protocolUserId: string; deviceKey: DeviceKey; nodeId: string }[]>();
    for (const row of rows) {
      // A credential already switched off: its lingering sessions are not
      // a device using the service.
      if (row.status !== "ACTIVE") continue;
      const seen = bySubscription.get(row.subscriptionId) ?? [];
      seen.push({ protocolUserId: row.id, deviceKey: deviceKeyOf(row.sessionId), nodeId });
      bySubscription.set(row.subscriptionId, seen);
    }

    for (const [subscriptionId, seen] of bySubscription) {
      await this.presence.record(subscriptionId, seen, now);
      // A device in use keeps its slot whether or not it renews.
      await this.slots.keepAlive(subscriptionId);
      await this.evaluate(subscriptionId, now);
    }
  }

  private async evaluate(subscriptionId: string, now: number) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      select: { status: true, plan: { select: { maxConcurrentConnections: true } } },
    });
    // An unset limit means unlimited, not zero.
    const limit = subscription?.plan?.maxConcurrentConnections;
    if (!subscription || subscription.status !== "ACTIVE" || !limit || limit <= 0) {
      this.forget(subscriptionId);
      return;
    }

    const [entries, credentials, slots] = await Promise.all([
      this.presence.entries(subscriptionId, PRESENCE_FRESH_MS, now),
      this.prisma.protocolUser.findMany({
        where: { subscriptionId },
        select: { id: true, routeId: true, sessionId: true, provisionedAt: true, heldUntil: true },
      }),
      this.slots.state(subscriptionId),
    ]);
    const devices = resolveDevices(entries, credentials, slots.credit);

    // A device holding a slot is never held -- not by a hold from before
    // it was let in (lifted at its grant as well, see liftOnGrant), nor by
    // one that raced its claim -- and nor is the shared credential it
    // named.
    const ownedBySlotHolder = (c: { id: string; sessionId: string | null }) =>
      slots.holders.has(deviceKeyOf(c.sessionId)) || slots.credit.has(c.id);
    const heldRows = credentials.filter((c) => c.heldUntil !== null && c.heldUntil.getTime() > now);
    await this.lift(
      subscriptionId,
      heldRows.filter(ownedBySlotHolder).map((c) => c.id),
    );
    const stillHeld = heldRows.filter((c) => !ownedBySlotHolder(c));

    // Holds are only honoured and extended while enforcing: switching back
    // to shadow lets any that exist lapse within HOLD_LEASE_MS.
    const enforcing = concurrencyCutMode() === "enforce";
    const held = new Set(enforcing ? stillHeld.map((c) => deviceKeyOf(c.sessionId)) : []);
    const free = [...devices.keys()].filter((key) => !held.has(key));

    // Holders using their slot with no traffic showing -- dialling, idle,
    // between renewals. They count against a device whose slot was taken
    // over and that is still going after its grace, and against nothing
    // else: that device was told, by the customer's own choice, to make
    // room for them, and with traffic alone it never looked over the
    // limit while they were quiet -- or while they were held, which is
    // how a taken-over PC on a censored path kept the phone that took
    // its place cut indefinitely.
    const quietHolders = [...slots.live].filter((key) => !free.includes(key)).length;
    const pastGrace = (key: DeviceKey) => {
      const d = slots.displaced.get(key);
      return d !== undefined && (d.noGrace || now - d.at >= DISPLACED_GRACE_MS);
    };
    const overstaying = free.filter((key) => !slots.holders.has(key) && pastGrace(key));

    // Keep a hold while the devices not held leave no room for it. A held
    // device shows no traffic of its own once it is cut, so "within the
    // limit" alone would lift it, it would come back, and the two would
    // take turns. Extended only while needed: once a device not held goes
    // quiet the holds lapse, and the re-assert brings the held device back
    // by itself.
    const extend = stillHeld.filter(
      (c) => free.length + (slots.displaced.has(deviceKeyOf(c.sessionId)) ? quietHolders : 0) >= limit,
    );
    if (enforcing && extend.length > 0) {
      await this.prisma.protocolUser.updateMany({
        where: { id: { in: extend.map((c) => c.id) } },
        data: { heldUntil: new Date(now + HOLD_LEASE_MS) },
      });
    }

    // Over the limit: more devices carrying traffic than the plan allows,
    // or a device taken over still going while the holders who took its
    // place are using their slots.
    const overByTraffic = free.length > limit;
    const overstayingExcess = overByTraffic ? 0 : Math.min(overstaying.length, free.length + quietHolders - limit);
    if (!overByTraffic && overstayingExcess <= 0) {
      // Back within the limit: forget the history rather than letting
      // strikes accumulate across unrelated incidents hours apart.
      this.strikes.delete(subscriptionId);
      this.lastStrikeAt.delete(subscriptionId);
      return;
    }
    const tally = overByTraffic
      ? `${free.length} devices active`
      : `${free.length} devices active and ${quietHolders} more holding a slot`;

    // One strike per cycle however many nodes report it.
    const lastStrike = this.lastStrikeAt.get(subscriptionId);
    if (lastStrike !== undefined && now - lastStrike < MIN_STRIKE_GAP_MS) return;
    this.lastStrikeAt.set(subscriptionId, now);
    const strikes = (this.strikes.get(subscriptionId) ?? 0) + 1;
    this.strikes.set(subscriptionId, strikes);
    if (strikes < STRIKES_BEFORE_ACTION) {
      this.logger.debug(
        `Subscription ${subscriptionId}: ${tally} against a limit of ${limit} (${strikes}/${STRIKES_BEFORE_ACTION})`,
      );
      return;
    }
    // A device holding a slot is never held: it asked first and was let
    // in. So node-side miscounting can never cut a single-device customer,
    // or a pair that takes turns through the app. Over the limit only
    // because of quiet holders, only the devices taken over are
    // candidates.
    const candidates = overByTraffic ? free.filter((key) => !slots.holders.has(key)) : overstaying;
    if (candidates.length === 0) {
      this.forget(subscriptionId);
      return;
    }
    // A device just taken over is told on its next renewal and disconnects
    // by itself; it gets that long before it can be held -- unless it had
    // itself just taken over, which is what overlapping grace periods on
    // purpose looks like. Waiting keeps the strikes, so it acts as soon as
    // the grace is over.
    const inGrace = candidates.some((key) => {
      const d = slots.displaced.get(key);
      return d !== undefined && !d.noGrace && now - d.at < DISPLACED_GRACE_MS;
    });
    if (inGrace) return;
    this.strikes.delete(subscriptionId);
    this.lastStrikeAt.delete(subscriptionId);

    const victims = this.pickDevicesToHold(
      candidates.map((key) => ({
        key,
        firstSeen: devices.get(key)!.firstSeen,
        displacedAt: slots.displaced.get(key)?.at ?? null,
      })),
      overByTraffic ? free.length - limit : overstayingExcess,
    );

    if (!enforcing) {
      const lastLog = this.lastShadowLogAt.get(subscriptionId);
      if (lastLog === undefined || now - lastLog >= SHADOW_LOG_INTERVAL_MS) {
        this.lastShadowLogAt.set(subscriptionId, now);
        this.logger.warn(
          `[shadow] Subscription ${subscriptionId}: ${tally} against a limit of ${limit}; ` +
            `would hold ${victims.map(describe).join(", ")} (CONCURRENCY_CUT=shadow, nothing sent)`,
        );
      }
      return;
    }

    for (const key of victims) await this.hold(subscriptionId, key, now, new Set(slots.credit.keys()));
    this.logger.warn(
      `Subscription ${subscriptionId}: ${tally} against a limit of ${limit}; holding ${victims.map(describe).join(", ")}`,
    );
  }

  /** Which devices to hold, at most `excess` of them, never one holding
   * a slot (the caller has removed those).
   *
   * A device whose slot was taken over first -- it was told, and is still
   * going -- then the shared pseudo-device, which cannot be told anything
   * and is the copy most likely not to be the customer's own current
   * device, then the newest device: the one whose activity began most
   * recently. Never all of them: the point, unlike the cut this replaces,
   * is that the device already in use keeps working. */
  private pickDevicesToHold(
    candidates: { key: DeviceKey; firstSeen: number; displacedAt: number | null }[],
    excess: number,
  ): DeviceKey[] {
    const tier = (c: (typeof candidates)[number]) => (c.displacedAt !== null ? 0 : c.key === SHARED_DEVICE ? 1 : 2);
    const ranked = [...candidates].sort((a, b) => {
      if (tier(a) !== tier(b)) return tier(a) - tier(b);
      if (a.displacedAt !== null && b.displacedAt !== null) return a.displacedAt - b.displacedAt;
      return b.firstSeen - a.firstSeen;
    });
    return ranked.slice(0, excess).map((c) => c.key);
  }

  /** Holds one device: every ACTIVE credential it has on the
   * subscription, targeted at its own inbound, kept off the re-assert by
   * the lease. Only in enforce mode.
   *
   * `credited` are the shared credentials slot holders named in their
   * claims. Their traffic is the holder's (resolveDevices), so they are
   * not part of the shared pseudo-device, and holding it must not touch
   * them: a PC whose own credential on route A was not confirmed yet
   * dials the shared one there and names it, while an old app on the
   * phone uses the shared credential of route B -- holding "the shared
   * credentials" then cut the PC, the slot holder, as well. */
  private async hold(subscriptionId: string, key: DeviceKey, now: number, credited: Set<string>) {
    const users = (
      await this.prisma.protocolUser.findMany({
        where: { subscriptionId, status: "ACTIVE", sessionId: sessionIdOf(key) },
        select: {
          id: true,
          nodeId: true,
          protocol: true,
          externalUserId: true,
          protocolConfig: { select: { transport: true, inboundTag: true } },
        },
      })
    ).filter((u) => !credited.has(u.id));
    if (users.length === 0) return;

    // The lease first: if the commands below fail, the re-assert must
    // still not put these back before the hold is meant to end.
    await this.prisma.protocolUser.updateMany({
      where: { id: { in: users.map((u) => u.id) } },
      data: { heldUntil: new Date(now + HOLD_LEASE_MS) },
    });

    // Dropping the user from the engine is the only lever there is: Xray
    // can add and remove a user but cannot close one of their open
    // connections, so a connection already open when the hold starts may
    // run on (unverified -- see docs/device-slots.md).
    for (const user of users) {
      await this.agentGateway
        .enqueueCommand(user.nodeId, "DISABLE_USER", {
          protocol: user.protocol,
          ...commandTarget(user.protocolConfig),
          externalUserId: user.externalUserId,
        })
        .catch((err: unknown) =>
          this.logger.error(`Could not hold ${user.externalUserId} (${subscriptionId}): ${String(err)}`),
        );
    }
  }

  private forget(subscriptionId: string) {
    this.strikes.delete(subscriptionId);
    this.lastStrikeAt.delete(subscriptionId);
  }
}

function bytes(value: string | undefined): bigint {
  try {
    return BigInt(value || "0");
  } catch {
    return 0n;
  }
}

function describe(key: DeviceKey): string {
  return key === SHARED_DEVICE ? "the shared credentials" : `device ${sessionIdOf(key)}`;
}
