import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../prisma/prisma.service";
import { parseTuning } from "../block-watch/block-signals";
import { assertClock, commandCutoff, pruneCommands, rollUpUsage, usageCutoff, type CommandRunResult, type UsageRunResult } from "./retention";

/** DATA_RETENTION: off (the default) | dry | on.
 *
 * Off by default so that deploying this does not start the first, large
 * purge at night unattended: the operator runs that one by hand after a
 * dump (docs/usage-retention.md) and then sets on. dry logs what a run
 * would do and changes nothing. Anything unrecognised is off. */
export type DataRetentionMode = "off" | "dry" | "on";

export function parseDataRetentionMode(raw: string | undefined | null): DataRetentionMode {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "on" || value === "dry" ? value : "off";
}

export interface RetentionRun {
  usage: UsageRunResult;
  commands: CommandRunResult;
  cutoffReason: string;
}

/** The nightly run of the retention in ./retention, for the sweeps queue. */
@Injectable()
export class DataRetentionService {
  private readonly logger = new Logger(DataRetentionService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  get mode(): DataRetentionMode {
    return parseDataRetentionMode(this.config.get<string>("dataRetention.mode"));
  }

  /** The nightly job. Never throws: a failure is logged, and whatever was
   * not done is done the next night. */
  async runNightly(now = new Date()): Promise<RetentionRun | null> {
    const mode = this.mode;
    if (mode === "off" || this.running) return null;
    this.running = true;
    try {
      return await this.run({ dryRun: mode === "dry", now });
    } catch (err) {
      this.logger.error(`data retention failed: ${(err as Error).message?.split("\n").pop()}`);
      return null;
    } finally {
      this.running = false;
    }
  }

  async run({ dryRun, now = new Date() }: { dryRun: boolean; now?: Date }): Promise<RetentionRun> {
    const { tuning } = parseTuning(this.config.get<string>("blockWatch.tuning"));
    await assertClock(this.prisma, now);
    const usage = await usageCutoff(this.prisma, now, tuning);
    const log = (m: string) => this.logger.log(m);
    const usageResult = await rollUpUsage(this.prisma, { cutoff: usage.cutoff, dryRun, log });
    const commands = await pruneCommands(this.prisma, { cutoff: commandCutoff(now), dryRun, log });
    const verb = dryRun ? "would remove" : "removed";
    this.logger.log(
      `data retention${dryRun ? " (dry run)" : ""}: usage before ${usage.cutoff.toISOString()} (${usage.reason}) ` +
        `${verb} ${usageResult.rows} row(s) into ${usageResult.hours} hour(s); commands ${verb} ${commands.total}` +
        (usageResult.totals && !usageResult.totals.equal ? "; USAGE TOTALS CHANGED, see docs/usage-retention.md" : ""),
    );
    return { usage: usageResult, commands, cutoffReason: usage.reason };
  }
}
