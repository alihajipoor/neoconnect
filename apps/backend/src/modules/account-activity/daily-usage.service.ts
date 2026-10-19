import { BadRequestException, HttpStatus, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  addDays,
  BUCKET_SECONDS,
  canonicalTimeZone,
  dailyTotals,
  localDate,
  MAX_AHEAD_OF_UTC_MS,
  utcMidnight,
  type DayTotal,
} from "./daily-usage";

export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 31;

export interface DailyUsage {
  subscriptionId: string;
  /** The zone the days are in, canonicalised. */
  timeZone: string;
  /** First and last day, YYYY-MM-DD. The last is today, so far. The
   * first is never before the day the subscription was created. */
  from: string;
  to: string;
  /** When this was read. */
  asOf: string;
  /** Oldest first. Every device on the subscription, both directions. */
  days: DayTotal[];
}

/** The bucket width as a literal in the SQL rather than a parameter: it
 * is a constant, and a literal leaves Postgres no parameter type to infer. */
const BUCKET = Prisma.raw(String(BUCKET_SECONDS));

interface BucketRow {
  bucket: bigint | number | string;
  up: string | null;
  down: string | null;
}

/** A subscription's data use per day (A6 in the client work list).
 *
 * Read from UsageRecord, the same rows that count against the plan's cap:
 * what the nodes reported for this subscription's credentials, every
 * device together, attributed to when it was reported (every ~30 s while
 * traffic flows). Nothing is estimated. What it cannot include is what
 * was never recorded or is no longer: traffic a node could not attribute
 * to a credential (a relay's shared uplink), and the rows of a node an
 * admin deleted (NodesService.remove). So the days are "as recorded", and
 * their sum is not the plan's used total -- that is
 * Subscription.dataUsedBytes, which neither of those touches. */
@Injectable()
export class DailyUsageService {
  constructor(private readonly prisma: PrismaService) {}

  async forSubscription(
    customerId: string,
    subscriptionId: string,
    options: { days?: number; timeZone?: string } = {},
  ): Promise<DailyUsage> {
    const timeZone = canonicalTimeZone(options.timeZone ?? "UTC");
    if (!timeZone) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        code: "UNKNOWN_TIME_ZONE",
        message: "tz must be an IANA time zone name, such as Asia/Tehran.",
      });
    }
    const days = Math.min(MAX_DAYS, Math.max(1, Math.trunc(options.days ?? DEFAULT_DAYS)));

    // Not found and not yours look the same, as everywhere else.
    const subscription = await this.prisma.subscription.findFirst({
      where: { id: subscriptionId, customerId },
      select: { id: true, createdAt: true },
    });
    if (!subscription) throw new NotFoundException("Subscription not found");

    const now = new Date();
    const to = localDate(now, timeZone);
    const created = localDate(subscription.createdAt, timeZone);
    let from = addDays(to, -(days - 1));
    if (created > from) from = created;

    // From before the first local midnight however far ahead of UTC the
    // zone is; buckets before that midnight are dropped by dailyTotals.
    const since = new Date(utcMidnight(from) - MAX_AHEAD_OF_UTC_MS);
    const until = new Date(now.getTime() + 1000);

    // reportedAt is TIMESTAMP(3) holding UTC, so its epoch is the UTC
    // epoch. The bounds are passed as text and pinned to UTC, so neither
    // the driver's parameter type nor the server's TimeZone setting can
    // shift them. Served by the (subscriptionId, reportedAt) index.
    const rows = await this.prisma.$queryRaw<BucketRow[]>`
      SELECT (FLOOR(EXTRACT(EPOCH FROM "reportedAt") / ${BUCKET}) * ${BUCKET})::bigint AS "bucket",
             SUM("bytesUp")::text AS "up",
             SUM("bytesDown")::text AS "down"
      FROM "usage_records"
      WHERE "subscriptionId" = ${subscription.id}
        AND "reportedAt" >= (${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
        AND "reportedAt" < (${until.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      GROUP BY 1
      ORDER BY 1`;

    return {
      subscriptionId: subscription.id,
      timeZone,
      from,
      to,
      asOf: now.toISOString(),
      days: dailyTotals(
        rows.map((row) => ({
          startSec: Number(row.bucket),
          bytesUp: BigInt(row.up ?? "0"),
          bytesDown: BigInt(row.down ?? "0"),
        })),
        timeZone,
        from,
        to,
      ),
    };
  }
}
