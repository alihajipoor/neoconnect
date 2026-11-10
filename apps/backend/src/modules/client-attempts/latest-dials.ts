import { Prisma } from "@prisma/client";

/** One row of latestDialsSql. */
export interface LatestDialRow {
  customerId: string;
  asn: number;
  routeId: string;
  carried: boolean;
  happenedAt: Date;
  createdAt: Date;
  rung: number;
}

/** Each customer's latest dial of each route, per network, from the
 * connect reports that arrived since `sinceMs`, on the given networks
 * only. Deduplicated in the database, so however many reports one
 * account sends, it is one row per route -- it can neither crowd out
 * anyone else's nor count twice. Ordered by when the client says it
 * happened (never after arrival), then by its place in the ladder.
 *
 * Bounded by the window and the networks, which is the (asn, createdAt)
 * index's range. Read by the block watch and by the connect order's
 * signals (isp-recommendations/isp-order.ts). */
export function latestDialsSql(sinceMs: number, asns: number[]): Prisma.Sql {
  return Prisma.sql`
    SELECT DISTINCT ON (a."customerId", a."asn", r.rung ->> 'routeId')
      a."customerId" AS "customerId",
      a."asn" AS "asn",
      r.rung ->> 'routeId' AS "routeId",
      (r.rung ->> 'carried')::boolean AS "carried",
      LEAST(COALESCE(a."occurredAt", a."createdAt"), a."createdAt") AS "happenedAt",
      a."createdAt" AS "createdAt",
      r.ord::int AS "rung"
    FROM "client_attempts" a
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(a."attemptsJson") = 'array' THEN a."attemptsJson" ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS r(rung, ord)
    WHERE a."createdAt" >= (to_timestamp(${sinceMs}::double precision / 1000) AT TIME ZONE 'UTC')
      AND a."kind" = 'CONNECT'
      AND a."customerId" IS NOT NULL
      AND a."asn" IN (${Prisma.join(asns)})
      AND jsonb_typeof(r.rung -> 'routeId') = 'string'
      AND jsonb_typeof(r.rung -> 'carried') = 'boolean'
    ORDER BY a."customerId", a."asn", r.rung ->> 'routeId',
      LEAST(COALESCE(a."occurredAt", a."createdAt"), a."createdAt") DESC, a."createdAt" DESC, r.ord DESC
  `;
}
