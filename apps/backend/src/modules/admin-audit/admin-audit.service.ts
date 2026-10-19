import { Injectable, Logger } from "@nestjs/common";
import type { AdminRole } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

export interface AdminAuditRecord {
  adminId: string;
  email: string;
  role: AdminRole;
  method: string;
  path: string;
  status: number;
  ip?: string;
}

/** How long an entry is kept. */
export const AUDIT_RETENTION_MS = 400 * 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

/** The admin action log (AdminAuditEntry): written by
 * AdminAuditInterceptor, read by SUPERADMIN at GET /admin/audit.
 *
 * Never throws when writing: a log that cannot be written must not undo
 * the change it describes, which has already been made. Entries older
 * than `AUDIT_RETENTION_MS` are pruned as new ones arrive, at most once a
 * day -- the backend has no scheduler, and admin changes are few. */
@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);
  private lastPrune = 0;

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AdminAuditRecord, now: number = Date.now()): Promise<void> {
    try {
      await this.prisma.adminAuditEntry.create({
        data: { ...entry, path: entry.path.slice(0, 512), ip: entry.ip?.slice(0, 64) ?? null },
      });
      if (now - this.lastPrune >= DAY_MS) {
        this.lastPrune = now;
        await this.prisma.adminAuditEntry.deleteMany({ where: { createdAt: { lt: new Date(now - AUDIT_RETENTION_MS) } } });
      }
    } catch (err) {
      this.logger.warn(`Admin action not logged (${entry.method} ${entry.path}): ${(err as Error).message}`);
    }
  }

  /** The newest entries first, `limit` at most (1 to 500), older than
   * `before` when given -- the createdAt of the last entry of the page
   * before. */
  list(limit = 100, before?: Date) {
    const take = Math.min(Math.max(Math.trunc(limit) || 100, 1), 500);
    return this.prisma.adminAuditEntry.findMany({
      where: before && !Number.isNaN(before.getTime()) ? { createdAt: { lt: before } } : undefined,
      orderBy: { createdAt: "desc" },
      take,
    });
  }
}
