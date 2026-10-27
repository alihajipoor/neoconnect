import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { insideVerdict, type ProbeLeg } from "./inside-probe";

/** How long checks are kept. Diagnostic, like the reachability history. */
export const INSIDE_RETENTION_DAYS = 30;

export interface InsideResult {
  nodeId: string;
  port: number;
  connectMs: number | null;
  down: ProbeLeg;
  up: ProbeLeg;
}

@Injectable()
export class InsideProbeService {
  private readonly logger = new Logger(InsideProbeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Stores one box's round. Results for nodes that do not exist (removed
   * since the list was made) are dropped, not errors. */
  async record(vantage: string, results: InsideResult[], now: Date = new Date()): Promise<number> {
    const known = new Set(
      (
        await this.prisma.node.findMany({
          where: { id: { in: [...new Set(results.map((r) => r.nodeId))] } },
          select: { id: true },
        })
      ).map((n) => n.id),
    );
    const rows = results
      .filter((r) => known.has(r.nodeId))
      .map((r) => ({
        nodeId: r.nodeId,
        vantage,
        port: r.port,
        verdict: insideVerdict(r.connectMs, r.down, r.up),
        connectMs: r.connectMs,
        downBytes: r.down.bytes,
        downMs: r.down.ms,
        upBytes: r.up.bytes,
        upMs: r.up.ms,
        checkedAt: now,
      }));
    if (rows.length > 0) await this.prisma.insideProbeCheck.createMany({ data: rows });
    await this.prisma.insideProbeCheck.deleteMany({
      where: { checkedAt: { lt: new Date(now.getTime() - INSIDE_RETENTION_DAYS * 86_400_000) } },
    });
    this.logger.log(`Inside probe from ${vantage}: ${rows.length} checks stored`);
    return rows.length;
  }
}
