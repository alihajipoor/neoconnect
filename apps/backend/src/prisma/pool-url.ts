/** Connection pools, sized in code so no .env change is needed.
 *
 * Until 2026-11-14 the URL carried no pool settings, so Prisma used its
 * default: physical CPUs x 2 + 1, which on the 2-CPU panel host is 5,
 * with a 10 s wait for a free connection. One customer's desktop client
 * racing the same heavy usage read across a dozen API addresses held all
 * five for over ten seconds; 78 queries timed out in the same instant,
 * among them seven agents' heartbeat writes, and those seven nodes lost
 * their control streams (see agent-gateway.service.ts).
 *
 * Two pools now, in two clients:
 *
 *   main       DATABASE_POOL_SIZE, default 20. Everything: the control
 *              plane (agent streams, sign-in, routes, device slots), the
 *              customer and admin API, the sweeps.
 *   reporting  REPORTING_DATABASE_POOL_SIZE, default 3. Heavy read-only
 *              reports over usage_records (DailyUsageService). When it is
 *              full its callers wait on it -- never on the main pool.
 *
 * Against Postgres max_connections = 100 (measured on production,
 * 2026-11-14; 3 of them reserved for superusers by default):
 *
 *   main pool                         20
 *   reporting pool                     3
 *   data-retention CLI (own process)   5   Prisma's default, run by hand
 *   prisma migrate deploy at start     1   before the app connects
 *   psql sessions, by hand             2
 *   superuser_reserved_connections     3
 *                                    ----
 *                                     34  of 100, leaving 66 spare --
 *
 * room for a second backend container during a deploy (another 23) and
 * still 43 over. The pool is not made larger than that because the host
 * has two CPUs: more connections than that do not make Postgres faster,
 * they make every query wait in its run queue instead of in the pool.
 *
 * A setting already present in DATABASE_URL always wins, so an operator
 * can still tune a pool from the URL alone. */

export interface PoolSettings {
  connectionLimit: number;
  poolTimeoutSeconds: number;
  applicationName: string;
}

export const MAIN_POOL_DEFAULT = 20;
export const MAIN_POOL_TIMEOUT_DEFAULT_S = 20;
export const REPORTING_POOL_DEFAULT = 3;
export const REPORTING_POOL_TIMEOUT_DEFAULT_S = 10;

function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= max ? n : fallback;
}

export function mainPoolSettings(env: NodeJS.ProcessEnv = process.env): PoolSettings {
  return {
    connectionLimit: positiveInt(env.DATABASE_POOL_SIZE, MAIN_POOL_DEFAULT, 80),
    poolTimeoutSeconds: positiveInt(env.DATABASE_POOL_TIMEOUT_S, MAIN_POOL_TIMEOUT_DEFAULT_S, 120),
    applicationName: "neoxify-backend",
  };
}

export function reportingPoolSettings(env: NodeJS.ProcessEnv = process.env): PoolSettings {
  return {
    connectionLimit: positiveInt(env.REPORTING_DATABASE_POOL_SIZE, REPORTING_POOL_DEFAULT, 20),
    poolTimeoutSeconds: REPORTING_POOL_TIMEOUT_DEFAULT_S,
    applicationName: "neoxify-reporting",
  };
}

/** The URL with the pool settings added where it does not already say.
 * Returns undefined for an undefined URL, so a client built without one
 * fails exactly as Prisma would have. */
export function withPool(url: string | undefined, settings: PoolSettings): string | undefined {
  if (!url) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL we can read (Prisma also accepts some it cannot); left
    // exactly as given rather than guessed at.
    return url;
  }
  const add = (key: string, value: string) => {
    if (!parsed.searchParams.has(key)) parsed.searchParams.set(key, value);
  };
  add("connection_limit", String(settings.connectionLimit));
  add("pool_timeout", String(settings.poolTimeoutSeconds));
  add("application_name", settings.applicationName);
  return parsed.toString();
}
