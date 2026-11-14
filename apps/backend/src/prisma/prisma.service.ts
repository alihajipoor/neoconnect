import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { mainPoolSettings, reportingPoolSettings, withPool, type PoolSettings } from "./pool-url";

/** Prisma options for a pool, or none when there is no DATABASE_URL --
 * Prisma then reports the missing variable itself, as before. */
function optionsFor(settings: PoolSettings) {
  const url = withPool(process.env.DATABASE_URL, settings);
  return url ? { datasources: { db: { url } } } : undefined;
}

/** The main pool: everything except the heavy reports. Sized in
 * pool-url.ts, where the arithmetic against max_connections is. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super(optionsFor(mainPoolSettings()));
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

/** A second, small pool for heavy read-only reports, so that however many
 * of them are in flight they wait on each other and never on the control
 * plane's connections. Connects on first use: a process that never runs a
 * report never opens it. See pool-url.ts. */
@Injectable()
export class ReportingPrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super(optionsFor(reportingPoolSettings()));
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
