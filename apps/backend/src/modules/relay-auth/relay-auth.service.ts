import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { AdminRole, Prisma, RelayAuthMode, type RelayAuthSettings } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { AsnLookupService } from "../network-identity/asn-lookup.service";
import { NetworkIdentityService } from "../network-identity/network-identity.service";
import { AlertingService } from "../alerting/alerting.service";
import { EmailService } from "../email/email.service";
import { RELAY_REGION_UNKNOWN_MESSAGE, type RelayContext } from "../../common/relay/relay-arrival";
import {
  BUCKET_MS,
  GLOBAL_DAILY_CAP,
  INTRANET_GRACE_MS,
  UNVERIFIED_IDLE_MS,
  bucketStart,
  capRefusal,
  evaluateDrop,
  powBits,
  stepSuspicion,
  type DropReading,
  type RelayTier,
  type SuspicionEvent,
  type TrafficCounts,
} from "./relay-policy";
import { relayOperatorMail } from "./relay-alerts";

const SETTINGS_TTL_MS = 15_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TRAFFIC_FLUSH_MS = 60_000;
const DETECTOR_TICK_MS = 5 * 60_000;
const TRAFFIC_RETENTION_MS = 8 * DAY_MS;
/** A box whose sign-ups in an hour reach this share of the day's cap is
 * reported to the owner (F14: a seized box can forge callers). */
const BOX_HOURLY_ALERT_SHARE = 0.25;
const BOX_ALERT_EVERY_MS = 6 * HOUR_MS;
const SWEEP_BATCH = 500;

/** A sign-up the caps have room for, held until it either happens or
 * does not. */
export interface SignupReservation {
  commit(): Promise<void>;
  release(): void;
}

function utcDay(now: number): Date {
  return new Date(Math.floor(now / DAY_MS) * DAY_MS);
}

function within(stamps: number[] | undefined, now: number, ms: number): number[] {
  return (stamps ?? []).filter((t) => now - t < ms);
}

/** Who has an unverified relay account worth deleting: never verified,
 * never paid in any way, and nothing done with it for 30 days. */
function abandonedUnverified(cutoff: Date): Prisma.CustomerWhereInput {
  return {
    emailVerifiedAt: null,
    relayUnverifiedSince: { not: null, lt: cutoff },
    subscriptions: { none: {} },
    voucherRedemptions: { none: {} },
    transactions: { none: {} },
    invoices: { none: {} },
    sessions: { none: { lastUsedAt: { gte: cutoff } } },
  };
}

/** Sign-up and sign-in through the Iranian relay of last resort
 * (docs/relay-last-resort.md): the owner's mode switch, the caps, the
 * auto detector, the unverified-account sweep, and the pause on the
 * session sweeps during a declared intranet.
 *
 * Holds no address. Callers are counted by `RelayContext.ipKey`, a
 * keyed hash under a key that dies with the process; networks and boxes
 * are counted by number and name.
 */
@Injectable()
export class RelayAuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RelayAuthService.name);
  private cached: { at: number; settings: RelayAuthSettings } | null = null;

  // Today's sign-ups, loaded from relay_daily_stats once a day and kept
  // in step in memory, so the caps survive a restart.
  private day = 0;
  private dayLoading: Promise<void> | null = null;
  private total = 0;
  private readonly byAsn = new Map<number, number>();
  // In memory only, and only by keyed hash.
  private readonly callers = new Map<string, number>();
  private readonly installs = new Map<string, number>();
  private readonly callerHour = new Map<string, number[]>();
  private globalHour: number[] = [];
  private readonly boxHour = new Map<string, number[]>();
  private readonly boxAlerted = new Map<string, number>();
  private mailsToday = 0;

  private readonly traffic = new Map<number, TrafficCounts>();
  private lastReading: (DropReading & { at: Date }) | null = null;
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly asn: AsnLookupService,
    private readonly identity: NetworkIdentityService,
    private readonly alerting: AlertingService,
    private readonly email: EmailService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === "test") return;
    const flush = setInterval(() => void this.flushTraffic(), TRAFFIC_FLUSH_MS);
    const tick = setInterval(() => void this.tickDetector(), DETECTOR_TICK_MS);
    flush.unref();
    tick.unref();
    this.timers.push(flush, tick);
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearInterval(timer);
  }

  // ------------------------------------------------------------ settings

  /** The singleton, cached briefly; `fresh` reads through the cache. */
  async settings(now = Date.now(), fresh = false): Promise<RelayAuthSettings> {
    if (!fresh && this.cached && now - this.cached.at < SETTINGS_TTL_MS) return this.cached.settings;
    const settings =
      (await this.prisma.relayAuthSettings.findFirst()) ?? (await this.prisma.relayAuthSettings.create({ data: {} }));
    this.cached = { at: now, settings };
    return settings;
  }

  async update(input: { mode?: RelayAuthMode; hostingAsns?: number[] }, now = new Date()) {
    const current = await this.settings(now.getTime(), true);
    const data: Prisma.RelayAuthSettingsUpdateInput = {};
    if (input.hostingAsns) data.hostingAsns = [...new Set(input.hostingAsns)].sort((a, b) => a - b);
    if (input.mode && input.mode !== current.mode) {
      data.mode = input.mode;
      if (input.mode === RelayAuthMode.INTRANET) data.intranetDeclaredAt = now;
      if (current.mode === RelayAuthMode.INTRANET) data.intranetEndedAt = now;
      // The detector's state belongs to the mode it was measured in.
      data.suspectedSince = null;
      data.suspicionAlertedAt = null;
      data.capsRaisedAt = null;
      this.logger.warn(`Relay sign-up mode changed from ${current.mode} to ${input.mode}`);
    }
    const settings = await this.prisma.relayAuthSettings.update({ where: { id: current.id }, data });
    this.cached = { at: Date.now(), settings };
    return settings;
  }

  /** What the apps may know: whether relay sign-up is open, and whether
   * the owner has declared an intranet -- the only thing that changes
   * what a customer reads (I4). */
  async publicStatus() {
    const settings = await this.settings();
    return { signup: settings.mode !== RelayAuthMode.OFF, intranet: settings.mode === RelayAuthMode.INTRANET };
  }

  tierOf(settings: RelayAuthSettings): RelayTier {
    if (settings.mode === RelayAuthMode.INTRANET) return "intranet";
    if (settings.mode === RelayAuthMode.AUTO && settings.capsRaisedAt) return "intranet";
    return "normal";
  }

  /** A declared intranet, or the 30 days after one ended: the time during
   * which nothing is taken away from anyone for having been unreachable. */
  async intranetHold(now = Date.now()): Promise<boolean> {
    const settings = await this.settings(now);
    if (settings.mode === RelayAuthMode.INTRANET) return true;
    return !!settings.intranetEndedAt && now - settings.intranetEndedAt.getTime() < INTRANET_GRACE_MS;
  }

  /** Whether this customer's idle sessions and their device credentials
   * must be kept (R4.5): during the hold, for anyone with an active
   * relay-only subscription. */
  async holdsSessionsOf(customerId: string, now = Date.now()): Promise<boolean> {
    if (!(await this.intranetHold(now))) return false;
    const held = await this.prisma.subscription.count({
      where: { customerId, status: "ACTIVE", plan: { relayOnly: true } },
    });
    return held > 0;
  }

  // ------------------------------------------------------- sign-up caps

  private async ensureDay(now: number): Promise<void> {
    const day = utcDay(now).getTime();
    if (this.day === day) return;
    this.dayLoading ??= (async () => {
      const rows = await this.prisma.relayDailyStat.groupBy({
        by: ["asn"],
        where: { day: new Date(day) },
        _sum: { signups: true },
      });
      this.byAsn.clear();
      this.callers.clear();
      this.installs.clear();
      this.total = 0;
      this.mailsToday = 0;
      for (const row of rows) {
        const count = row._sum.signups ?? 0;
        this.byAsn.set(row.asn, count);
        this.total += count;
      }
      this.day = day;
    })().finally(() => {
      this.dayLoading = null;
    });
    await this.dayLoading;
  }

  /** Bits of proof of work a relay sign-up from this caller costs now. */
  signupPowBits(ctx: RelayContext | null, installId?: string | null, now = Date.now()): number {
    this.globalHour = within(this.globalHour, now, HOUR_MS);
    const ipLastHour = ctx ? within(this.callerHour.get(ctx.ipKey), now, HOUR_MS).length : 0;
    const installToday = installId ? (this.installs.get(installId) ?? 0) : 0;
    return powBits({ ipLastHour, globalLastHour: this.globalHour.length, installToday });
  }

  /** Room for one sign-up that skips verification, or the refusal.
   *
   * Checked and held in one synchronous step after the day is loaded, so
   * two sign-ups at once cannot both take the last place. */
  async reserveSignup(ctx: RelayContext, installId?: string | null, now = Date.now()): Promise<SignupReservation> {
    const settings = await this.assertSignupOpen(ctx, now);
    await this.ensureDay(now);

    // assertSignupOpen has refused an unknown network.
    const asn = ctx.asn!;
    const hostingAsns = new Set(settings.hostingAsns);
    let hosting = 0;
    for (const listed of hostingAsns) hosting += this.byAsn.get(listed) ?? 0;
    const refusal = capRefusal(this.tierOf(settings), hostingAsns.has(asn), {
      total: this.total,
      network: this.byAsn.get(asn) ?? 0,
      hosting,
      caller: this.callers.get(ctx.ipKey) ?? 0,
    });
    if (refusal) {
      this.logger.warn(`Relay sign-up refused by the ${refusal} cap (AS${asn}, box "${ctx.box}")`);
      await this.recordRefusal(ctx);
      throw new HttpException(
        {
          statusCode: 429,
          code: "RELAY_SIGNUP_LIMIT",
          message: "Too many people are signing up through the backup route right now. Try again later.",
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const bump = (delta: number) => {
      this.total += delta;
      this.byAsn.set(asn, (this.byAsn.get(asn) ?? 0) + delta);
      this.callers.set(ctx.ipKey, (this.callers.get(ctx.ipKey) ?? 0) + delta);
      if (installId) this.installs.set(installId, (this.installs.get(installId) ?? 0) + delta);
    };
    bump(1);
    let settled = false;
    return {
      release: () => {
        if (settled) return;
        settled = true;
        bump(-1);
      },
      commit: async () => {
        if (settled) return;
        settled = true;
        this.globalHour.push(now);
        this.callerHour.set(ctx.ipKey, [...within(this.callerHour.get(ctx.ipKey), now, HOUR_MS), now]);
        await this.bumpStat(ctx, { signups: 1 });
        await this.watchBox(ctx.box, settings, now);
      },
    };
  }

  /** The cheap refusals, before a caller is asked to spend anything on
   * proof of work: the owner has switched relay sign-up off, or the
   * caller's network is not registered in Iran (R3.1). An unknown network
   * cannot sign up either (F5), and is told so with its own code,
   * RELAY_REGION_UNKNOWN: the app switches the relay off for a day on
   * RELAY_REGION, and an unknown network may still sign in. */
  async assertSignupOpen(ctx: RelayContext, now = Date.now()): Promise<RelayAuthSettings> {
    const settings = await this.settings(now);
    if (settings.mode === RelayAuthMode.OFF) {
      throw new ForbiddenException({
        statusCode: 403,
        code: "RELAY_SIGNUP_OFF",
        message: "You can't sign up through the backup route right now.",
      });
    }
    if (ctx.region !== null && ctx.region !== "IR") {
      throw new ForbiddenException({
        statusCode: 403,
        code: "RELAY_REGION",
        message: "The backup route only works for connections from inside the country its server is in.",
      });
    }
    if (ctx.region === null || ctx.asn === null) {
      throw new ForbiddenException({
        statusCode: 403,
        code: "RELAY_REGION_UNKNOWN",
        message: RELAY_REGION_UNKNOWN_MESSAGE,
      });
    }
    return settings;
  }

  /** Whether an unverified account signing in over the relay may become
   * relay-unverified (R4.2). Asked only for that conversion: an account
   * that already is relay-unverified signs in without asking, charged
   * nothing, whatever the caps and the switch say.
   *
   * An account holding paid access -- an active subscription, or a
   * relay-only one that was ever paid for -- is let in at once and charged
   * no place: paying users are never locked out (owner, 2026-10-15).
   * Anyone else on a relay sign-up's terms, in its order: the switch and
   * the region, at least the sign-up's proof of work (F4: without it the
   * caps are a lever any free unverified account could pull for nothing),
   * then a place under the same caps -- otherwise accounts made on the
   * normal routes and signed in here would be a way around them.
   *
   * Returns the held place, which the caller commits once the account is
   * converted and releases otherwise, or null when none is charged. A
   * refusal is thrown and says why -- RELAY_SIGNUP_OFF, RELAY_REGION,
   * CHALLENGE_REQUIRED, RELAY_SIGNUP_LIMIT -- never "verify your email",
   * which is untrue and, during an intranet, impossible. */
  async admitUnverifiedSignIn(
    ctx: RelayContext,
    customerId: string,
    provenBits: number,
    now = Date.now(),
  ): Promise<SignupReservation | null> {
    if (await this.holdsPaidAccess(customerId)) return null;
    await this.assertSignupOpen(ctx, now);
    if (provenBits < this.signupPowBits(ctx, null, now)) {
      // The client fetches a challenge with scope "relay-signup", which is
      // minted at the caller's relay difficulty, and signs in again.
      throw new BadRequestException({
        statusCode: 400,
        code: "CHALLENGE_REQUIRED",
        scope: "relay-signup",
        message: "A security check is required. Please try again.",
      });
    }
    return this.reserveSignup(ctx, null, now);
  }

  private async holdsPaidAccess(customerId: string): Promise<boolean> {
    const held = await this.prisma.subscription.count({
      where: {
        customerId,
        OR: [{ status: "ACTIVE" }, { status: { not: "PENDING" }, plan: { relayOnly: true } }],
      },
    });
    return held > 0;
  }

  async recordSignIn(ctx: RelayContext): Promise<void> {
    await this.bumpStat(ctx, { signIns: 1 });
  }

  async recordRefusal(ctx: RelayContext): Promise<void> {
    await this.bumpStat(ctx, { refusals: 1 });
  }

  /** Never throws: a count is not worth a customer's sign-in. */
  private async bumpStat(ctx: RelayContext, by: { signups?: number; signIns?: number; refusals?: number }) {
    const key = { day: utcDay(Date.now()), box: ctx.box, asn: ctx.asn ?? 0 };
    try {
      await this.prisma.relayDailyStat.upsert({
        where: { day_box_asn: key },
        create: { ...key, signups: by.signups ?? 0, signIns: by.signIns ?? 0, refusals: by.refusals ?? 0 },
        update: {
          signups: { increment: by.signups ?? 0 },
          signIns: { increment: by.signIns ?? 0 },
          refusals: { increment: by.refusals ?? 0 },
        },
      });
    } catch (err) {
      this.logger.warn(`Could not record a relay count: ${(err as Error).message}`);
    }
  }

  private async watchBox(box: string, settings: RelayAuthSettings, now: number) {
    const recent = [...within(this.boxHour.get(box), now, HOUR_MS), now];
    this.boxHour.set(box, recent);
    const threshold = Math.floor(GLOBAL_DAILY_CAP[this.tierOf(settings)] * BOX_HOURLY_ALERT_SHARE);
    const last = this.boxAlerted.get(box) ?? 0;
    if (recent.length >= threshold && now - last >= BOX_ALERT_EVERY_MS) {
      this.boxAlerted.set(box, now);
      await this.notifyOwner(
        `Relay box "${box || "(unnamed)"}": ${recent.length} sign-ups in the last hour`,
        `${recent.length} accounts were created through relay box "${box || "(unnamed)"}" in the last hour, ` +
          `against a daily cap of ${GLOBAL_DAILY_CAP[this.tierOf(settings)]}. A box that has been taken over can ` +
          "make up callers; if this does not match what you expect, firewall the box out at the origin and rotate it " +
          "through the signed bundle (docs/relay-last-resort.md, R9.2).",
      );
    }
  }

  // ---------------------------------------------------------------- mail

  /** Whether a verification or reset mail may go to this account now
   * (R3.7). Only relay-unverified accounts are limited: one mail per
   * address a day, and a daily total across all of them. Taking the
   * place is a conditional write, so two requests cannot both send. */
  async takeRelayMail(
    customer: { id: string; emailVerifiedAt: Date | null; relayUnverifiedSince: Date | null },
    now = Date.now(),
  ): Promise<boolean> {
    if (customer.emailVerifiedAt || !customer.relayUnverifiedSince) return true;
    await this.ensureDay(now);
    const settings = await this.settings(now);
    if (this.mailsToday >= GLOBAL_DAILY_CAP[this.tierOf(settings)]) return false;
    const { count } = await this.prisma.customer.updateMany({
      where: {
        id: customer.id,
        OR: [{ relayMailAt: null }, { relayMailAt: { lt: new Date(now - DAY_MS) } }],
      },
      data: { relayMailAt: new Date(now) },
    });
    if (count === 0) return false;
    this.mailsToday += 1;
    return true;
  }

  // ------------------------------------------------------------ detector

  /** Counts one request on the normal API by where its caller's network
   * is registered. Our own addresses (a node's mirror, a live tunnel) say
   * nothing about Iran and are skipped. */
  observe(ip: string | undefined | null): void {
    if (!ip) return;
    const country = this.asn.regionOf(ip);
    if (country === null) return;
    void this.identity
      .isOwnAddress(ip)
      .then((own) => {
        if (own) return;
        const start = bucketStart(Date.now());
        const counts = this.traffic.get(start) ?? { ir: 0, other: 0 };
        if (country === "IR") counts.ir += 1;
        else counts.other += 1;
        this.traffic.set(start, counts);
      })
      .catch(() => undefined);
  }

  async flushTraffic(): Promise<void> {
    const pending = [...this.traffic.entries()];
    this.traffic.clear();
    for (const [start, counts] of pending) {
      try {
        await this.prisma.relayTrafficBucket.upsert({
          where: { start: new Date(start) },
          create: { start: new Date(start), ir: counts.ir, other: counts.other },
          update: { ir: { increment: counts.ir }, other: { increment: counts.other } },
        });
      } catch (err) {
        this.logger.warn(`Could not record relay traffic counts: ${(err as Error).message}`);
      }
    }
  }

  /** One detector step (R2.5). Only in AUTO: OFF wants nothing, and in a
   * declared intranet the owner already knows. */
  async tickDetector(now = new Date()): Promise<void> {
    try {
      await this.flushTraffic();
      await this.prisma.relayTrafficBucket.deleteMany({
        where: { start: { lt: new Date(now.getTime() - TRAFFIC_RETENTION_MS) } },
      });
      const settings = await this.settings(now.getTime(), true);
      if (settings.mode !== RelayAuthMode.AUTO) return;

      const rows = await this.prisma.relayTrafficBucket.findMany({
        where: { start: { gte: new Date(now.getTime() - TRAFFIC_RETENTION_MS) } },
      });
      const buckets = new Map(rows.map((r) => [r.start.getTime(), { ir: r.ir, other: r.other }]));
      const reading = evaluateDrop(buckets, now.getTime());
      this.lastReading = { ...reading, at: now };
      const { next, events } = stepSuspicion(settings, reading.holds, now);
      if (
        next.suspectedSince?.getTime() !== settings.suspectedSince?.getTime() ||
        next.suspicionAlertedAt?.getTime() !== settings.suspicionAlertedAt?.getTime() ||
        next.capsRaisedAt?.getTime() !== settings.capsRaisedAt?.getTime()
      ) {
        const saved = await this.prisma.relayAuthSettings.update({ where: { id: settings.id }, data: next });
        this.cached = { at: Date.now(), settings: saved };
      }
      for (const event of events) await this.announce(event, reading);
    } catch (err) {
      this.logger.warn(`Relay detector step failed: ${(err as Error).message}`);
    }
  }

  private async announce(event: SuspicionEvent, reading: DropReading) {
    const numbers =
      `Iranian requests on the normal routes in the last half hour: ${reading.ir} (7-day median ${reading.irMedian}); ` +
      `everyone else: ${reading.other} (median ${reading.otherMedian}).`;
    if (event === "alert") {
      await this.notifyOwner(
        "Iranian traffic has dropped: possible national intranet",
        `${numbers} This has held for 30 minutes. It can also mean only our domains are blocked in Iran. ` +
          "Nothing customers see has changed. If Iran's international links are cut, declare the intranet in " +
          "Panel -> Settings -> Relay sign-up. If it holds another 30 minutes, relay sign-up caps rise to the intranet tier.",
      );
    } else if (event === "raise") {
      await this.notifyOwner(
        "Relay sign-up caps raised to the intranet tier",
        `${numbers} The drop has held for an hour, so relay sign-ups now run at the intranet caps ` +
          `(${GLOBAL_DAILY_CAP.intranet} a day). Customer wording and sweeps are unchanged until you declare the intranet.`,
      );
    } else {
      await this.notifyOwner(
        "Iranian traffic has recovered",
        `${numbers} The drop is over; relay sign-up caps are back to normal.`,
      );
    }
  }

  private async notifyOwner(subject: string, text: string): Promise<void> {
    await this.alerting.send(`[relay] ${subject}. ${text}`);
    try {
      const admins = await this.prisma.adminUser.findMany({
        where: { role: AdminRole.SUPERADMIN },
        select: { email: true },
      });
      const mail = relayOperatorMail(subject, text);
      for (const admin of admins) await this.email.sendMail({ to: admin.email, ...mail });
    } catch (err) {
      this.logger.warn(`Could not mail the relay alert: ${(err as Error).message}`);
    }
  }

  // --------------------------------------------------------------- sweep

  /** Deletes unverified relay accounts that never paid and have not been
   * used for 30 days, which frees their address (R3.8). Paused during a
   * declared intranet and the 30 days after it. */
  async sweepUnverified(now = Date.now()): Promise<number> {
    if (await this.intranetHold(now)) {
      this.logger.log("Unverified relay account sweep paused: intranet declared or recently ended");
      return 0;
    }
    const where = abandonedUnverified(new Date(now - UNVERIFIED_IDLE_MS));
    let deleted = 0;
    for (let round = 0; round < 20; round += 1) {
      const batch = await this.prisma.customer.findMany({ where, select: { id: true }, take: SWEEP_BATCH });
      if (batch.length === 0) break;
      const ids = batch.map((c) => c.id);
      try {
        deleted += (await this.prisma.customer.deleteMany({ where: { ...where, id: { in: ids } } })).count;
      } catch {
        // Something else points at one of them; take them one at a time
        // and leave the ones that cannot go.
        for (const id of ids) {
          try {
            deleted += (await this.prisma.customer.deleteMany({ where: { ...where, id } })).count;
          } catch (err) {
            this.logger.warn(`Could not delete unverified relay account ${id}: ${(err as Error).message}`);
          }
        }
      }
      if (batch.length < SWEEP_BATCH) break;
    }
    if (deleted > 0) this.logger.log(`Deleted ${deleted} unpaid unverified relay account(s) idle 30 days`);
    return deleted;
  }

  // --------------------------------------------------------------- admin

  async adminStatus(now = Date.now()) {
    const settings = await this.settings(now, true);
    const tier = this.tierOf(settings);
    const cap = GLOBAL_DAILY_CAP[tier];
    const rows = await this.prisma.relayDailyStat.findMany({
      where: { day: utcDay(now) },
      orderBy: [{ signups: "desc" }, { signIns: "desc" }],
    });
    return {
      settings,
      tier,
      caps: { global: cap, perNetwork: Math.floor(cap * 0.25), hosting: Math.floor(cap * 0.05) },
      hold: await this.intranetHold(now),
      today: {
        signups: rows.reduce((n, r) => n + r.signups, 0),
        signIns: rows.reduce((n, r) => n + r.signIns, 0),
        refusals: rows.reduce((n, r) => n + r.refusals, 0),
        rows: rows.map((r) => ({ ...r, org: r.asn ? this.asn.orgOf(r.asn) : null })),
      },
      detector: this.lastReading,
      bucketMinutes: BUCKET_MS / 60_000,
    };
  }
}
