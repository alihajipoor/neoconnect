import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { AsnTable, AsnTableBuilder, type AsnInfo } from "./asn-table";

/** How often the table is rebuilt. The upstream file is regenerated
 * hourly from BGP; networks are renumbered on a scale of weeks, so once a
 * day keeps it current at a cost of one download a day. */
const REFRESH_MS = 24 * 3_600_000;

/** A sanity floor on a freshly parsed table.
 *
 * The real file has hundreds of thousands of ranges. A download that was
 * truncated, or answered with an error page that happened to be gzip,
 * parses to a handful -- and swapping that in would quietly turn every
 * customer's network into "unknown". Keeping yesterday's table is
 * strictly better. */
const MIN_PLAUSIBLE_ROWS = 100_000;

/** Answers "which network is this address on" from an offline table.
 *
 * Per process and in memory, which is why the refresh is a timer here
 * rather than a job on the sweeps queue: a queued job runs in whichever
 * worker picks it up, and every process that answers requests needs its
 * own copy.
 *
 * Every failure degrades to `null`, which every caller already treats
 * as "network unknown" -- no tags in the picker, nothing else different.
 * A broken dataset must never be able to break /health/ip, which the
 * clients' egress check depends on.
 */
@Injectable()
export class AsnLookupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AsnLookupService.name);
  private table: AsnTable | null = null;
  private loadedAt: Date | null = null;
  private timer: NodeJS.Timeout | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    if (!this.config.get<boolean>("asn.enabled")) return;
    // Not awaited: the API must come up and serve while the table loads.
    // Lookups in that window answer null, which is "unknown".
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** The network an address belongs to, or null when the table is not
   * loaded or the address is in no announced range. */
  lookup(ip: string | undefined | null): AsnInfo | null {
    if (!ip || !this.table) return null;
    return this.table.lookup(ip);
  }

  orgOf(asn: number): string | null {
    return this.table?.orgOf(asn) ?? null;
  }

  status() {
    return { loaded: this.table !== null, ranges: this.table?.size ?? 0, loadedAt: this.loadedAt };
  }

  /** Replaces the table. For tests, and for a deployment that wants to
   * load a file by some other route. */
  use(table: AsnTable): void {
    this.table = table;
    this.loadedAt = new Date();
  }

  private datasetPath(): string {
    return this.config.get<string>("asn.datasetPath") || join(tmpdir(), "neoxify-ip2asn-combined.tsv.gz");
  }

  /** Downloads a fresh copy if one is configured, then loads whatever is
   * on disk. One at a time: a slow download overlapping the next timer
   * tick would otherwise parse the same file twice at once. */
  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    const path = this.datasetPath();
    const url = this.config.get<string>("asn.datasetUrl");
    if (url) {
      try {
        await this.download(url, path);
      } catch (err) {
        // Not fatal: the file from the last successful download, if any,
        // is loaded below. Logged, because a download that fails every
        // day means a table that silently ages.
        this.logger.warn(`ASN dataset download failed, keeping what is on disk: ${(err as Error).message}`);
      }
    }

    try {
      await stat(path);
    } catch {
      if (!this.table) this.logger.warn(`No ASN dataset at ${path}; per-ISP recommendations are off until one loads`);
      return;
    }

    try {
      const table = await loadGzippedTsv(path);
      if (table.size < MIN_PLAUSIBLE_ROWS) {
        this.logger.warn(`ASN dataset at ${path} has only ${table.size} ranges; not using it`);
        return;
      }
      this.use(table);
      this.logger.log(`ASN table loaded: ${table.size} ranges`);
    } catch (err) {
      this.logger.warn(`Could not load the ASN dataset: ${(err as Error).message}`);
    }
  }

  /** Fetches to a temporary name and renames into place, so a download
   * that dies halfway never replaces a good file with half of one. */
  private async download(url: string, path: string): Promise<void> {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await mkdir(dirname(path), { recursive: true });
    const partial = `${path}.partial`;
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(partial));
    await rename(partial, path);
  }
}

/** Streams a gzipped ip2asn TSV into a table, a line at a time.
 *
 * Iterated directly rather than through `readline` or `.pipe()`, because
 * neither forwards a stream error to the consumer reliably -- and a
 * corrupt download raising an unhandled error event would take the
 * whole API down over a feature that is meant to degrade to nothing.
 * Async iteration rejects instead, which `doRefresh` catches. */
export async function loadGzippedTsv(path: string): Promise<AsnTable> {
  const builder = new AsnTableBuilder();
  const gunzip = createGunzip();
  const source = createReadStream(path);
  source.on("error", (err) => gunzip.destroy(err));
  source.pipe(gunzip);
  // Decoded by the stream, not per chunk: an org name with a multi-byte
  // character split across two chunks would otherwise be mangled.
  gunzip.setEncoding("utf8");
  let carry = "";
  for await (const chunk of gunzip) {
    const text = carry + (chunk as string);
    const lines = text.split("\n");
    carry = lines.pop() ?? "";
    for (const line of lines) builder.addLine(line.replace(/\r$/, ""));
  }
  if (carry) builder.addLine(carry.replace(/\r$/, ""));
  return builder.build();
}
