import { Injectable, Logger } from "@nestjs/common";
import { ClientAttemptKind, ClientAttemptOutcome, Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ReportAttemptDto } from "./dto/report-attempt.dto";

/** How long a report is kept.
 *
 * These rows are IP addresses belonging to people in a country where
 * that is dangerous to hold, gathered to debug a beta rather than to
 * build a record. Two weeks is long enough to see a pattern across a
 * test group and short enough that there is little to lose.
 *
 * Deliberately a constant with this note attached rather than a setting:
 * a retention window that can be raised quietly tends to be.
 */
export const RETENTION_DAYS = 14;

/** The most rungs kept from one connect.
 *
 * A ladder pass tries at most the credentials a subscription holds --
 * five today. The cap is on the report rather than on trust: this
 * endpoint is unauthenticated, and an array is the easy way to make one
 * row very large.
 */
const MAX_RUNGS = 12;

/** A client's own timestamp, kept only where it can be true.
 *
 * Queued reports are the whole reason this field exists, so a past date
 * is expected and welcome. What is not: a future one, or one older than
 * the window the row will live in -- both mean a wrong clock or a caller
 * making things up, and displaying either is worse than displaying
 * nothing. A little slack forward absorbs ordinary clock skew.
 */
export function plausibleOccurredAt(value: string | undefined, now = Date.now()): Date | null {
  if (!value) return null;
  const at = new Date(value);
  const ms = at.getTime();
  if (Number.isNaN(ms)) return null;
  if (ms > now + 5 * 60_000) return null;
  if (ms < now - RETENTION_DAYS * 86_400_000) return null;
  return at;
}

@Injectable()
export class ClientAttemptsService {
  private readonly logger = new Logger(ClientAttemptsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Records one report. Never throws to the caller.
   *
   * A client reporting a failure must not then fail because the report
   * failed -- it is already having a bad time, and losing the report is
   * strictly better than turning it into a second error on the customer's
   * screen.
   */
  async record(
    dto: ReportAttemptDto,
    context: { customerId?: string; ip?: string },
  ): Promise<void> {
    const data = (customerId: string | null) => ({
      kind: dto.kind,
      outcome: dto.outcome,
      customerId,
      platform: dto.platform,
      appVersion: dto.appVersion,
      routeId: dto.routeId ?? null,
      protocol: dto.protocol ?? null,
      apiEndpoint: dto.apiEndpoint ?? null,
      reason: dto.reason ?? null,
      attemptsJson: dto.attempts?.length
        ? (dto.attempts.slice(0, MAX_RUNGS) as unknown as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      ip: context.ip ?? null,
      // Kept only if it is in the past and inside the retention window.
      // A queued report is by definition older than its arrival; a
      // future date or an ancient one is a broken clock or a bored
      // stranger, and either way is worse than no answer.
      occurredAt: plausibleOccurredAt(dto.occurredAt),
    });

    try {
      await this.prisma.clientAttempt.create({ data: data(context.customerId ?? null) });
    } catch (err) {
      // A token can outlive the customer it names -- deleted from the
      // panel while an access token is still inside its 15 minutes -- and
      // then the foreign key rejects the whole row. The attribution is
      // the disposable part of the report, so drop it and keep the rest
      // rather than losing a failure report over a stale id.
      if (context.customerId) {
        try {
          await this.prisma.clientAttempt.create({ data: data(null) });
          return;
        } catch {
          // Fall through to the warning below with the original error.
        }
      }
      this.logger.warn(`Could not record a client attempt: ${(err as Error).message}`);
    }
  }

  /** The panel's list, newest first.
   *
   * Filters are the three questions actually asked of it: what went
   * wrong, on which platform, and was it a sign-in or a connect.
   */
  async list(filters: {
    outcome?: ClientAttemptOutcome;
    kind?: ClientAttemptKind;
    platform?: string;
    /** Failures only -- the default view, because a list dominated by
     * successes buries the thing being looked for. */
    failuresOnly?: boolean;
    take?: number;
  }) {
    const where: Prisma.ClientAttemptWhereInput = {};
    if (filters.outcome) where.outcome = filters.outcome;
    if (filters.kind) where.kind = filters.kind;
    if (filters.platform) where.platform = filters.platform;
    if (filters.failuresOnly) where.outcome = { not: ClientAttemptOutcome.SUCCESS };

    return this.prisma.clientAttempt.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(filters.take ?? 100, 500),
      include: { customer: { select: { id: true, email: true } } },
    });
  }

  /** A count per outcome over the window, for the summary strip.
   *
   * The useful signal in a beta is proportion, not volume: "nine of
   * eleven connects never reached the control plane" is a diagnosis,
   * while "eleven attempts" is not.
   */
  async summary(sinceHours = 24) {
    const since = new Date(Date.now() - sinceHours * 3_600_000);
    const rows = await this.prisma.clientAttempt.groupBy({
      by: ["outcome"],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    });
    return rows.map((r) => ({ outcome: r.outcome, count: r._count._all }));
  }

  /** Drops anything past the retention window. Called by the sweep. */
  async prune(): Promise<number> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
    const { count } = await this.prisma.clientAttempt.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (count > 0) this.logger.log(`Pruned ${count} client attempts older than ${RETENTION_DAYS} days`);
    return count;
  }
}
