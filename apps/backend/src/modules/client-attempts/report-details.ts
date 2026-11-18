import type { Prisma } from "@prisma/client";
import type { ReportDetailsDto } from "./dto/report-details.dto";
import { isServiceCheckHost } from "./service-check-targets";

/** The most a stored `details` object may weigh, serialized, in bytes.
 * Over it the details are dropped and the report kept: the report is the
 * part worth having, and a bundle this size is either a bug or abuse. */
export const DETAILS_MAX_BYTES = 8 * 1024;

export type DetailsVerdict =
  | { details: Prisma.InputJsonObject; dropped: null; servicesDropped: number }
  | { details: null; dropped: "empty" | "too-large"; servicesDropped: number; bytes?: number };

/** What of a validated `details` object is stored.
 *
 * 1. Undefined keys go (a JSON round trip): the stored object is exactly
 *    what the client sent and the DTO allowed.
 * 2. THE BOUNDARY, enforced here and not in the client: a service result
 *    whose host is not on the server's fixed list, current or previous, is
 *    dropped. A modified client can send anything the DTO accepts; it
 *    cannot make this server keep a result for a site it did not choose.
 *    If no result is left the key goes.
 * 3. Over DETAILS_MAX_BYTES the whole object is dropped.
 */
export function keepServiceResults(input: ReportDetailsDto | undefined | null): DetailsVerdict {
  if (!input) return { details: null, dropped: "empty", servicesDropped: 0 };
  const details = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  let servicesDropped = 0;
  if (Array.isArray(details.services)) {
    const kept = (details.services as { host?: unknown }[]).filter(
      (s) => typeof s?.host === "string" && isServiceCheckHost(s.host),
    );
    servicesDropped = details.services.length - kept.length;
    if (kept.length > 0) details.services = kept;
    else delete details.services;
  }
  if (Object.keys(details).length === 0) return { details: null, dropped: "empty", servicesDropped };
  const bytes = Buffer.byteLength(JSON.stringify(details), "utf8");
  if (bytes > DETAILS_MAX_BYTES) return { details: null, dropped: "too-large", servicesDropped, bytes };
  return { details: details as Prisma.InputJsonObject, dropped: null, servicesDropped };
}
