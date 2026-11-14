import {
  MAIN_POOL_DEFAULT,
  REPORTING_POOL_DEFAULT,
  mainPoolSettings,
  reportingPoolSettings,
  withPool,
} from "./pool-url";

/** The pools are sized in code because the production URL carried no
 * settings, and Prisma's default on a 2-CPU host is 5 connections -- the
 * pool that ran dry on 2026-11-14. */
describe("pool settings", () => {
  const URL_ = "postgresql://user:secret@postgres:5432/neoxify?schema=public";

  it("adds an explicit, larger pool to a URL that names none", () => {
    const url = new URL(withPool(URL_, mainPoolSettings({}))!);
    expect(url.searchParams.get("connection_limit")).toBe(String(MAIN_POOL_DEFAULT));
    expect(url.searchParams.get("pool_timeout")).toBe("20");
    expect(url.searchParams.get("application_name")).toBe("neoxify-backend");
    // Everything already there is kept as it was.
    expect(url.searchParams.get("schema")).toBe("public");
    expect(url.password).toBe("secret");
    expect(MAIN_POOL_DEFAULT).toBeGreaterThan(5);
  });

  it("lets the URL win over the code, and the environment over the default", () => {
    const fromUrl = new URL(withPool(`${URL_}&connection_limit=7`, mainPoolSettings({ DATABASE_POOL_SIZE: "30" }))!);
    expect(fromUrl.searchParams.get("connection_limit")).toBe("7");
    expect(mainPoolSettings({ DATABASE_POOL_SIZE: "30" }).connectionLimit).toBe(30);
    expect(reportingPoolSettings({ REPORTING_DATABASE_POOL_SIZE: "2" }).connectionLimit).toBe(2);
  });

  it("ignores a nonsense override rather than starting with a broken pool", () => {
    for (const bad of ["0", "-3", "abc", "2.5", "500"]) {
      expect(mainPoolSettings({ DATABASE_POOL_SIZE: bad }).connectionLimit).toBe(MAIN_POOL_DEFAULT);
    }
  });

  it("gives the reports their own pool, with its own name", () => {
    const url = new URL(withPool(URL_, reportingPoolSettings({}))!);
    expect(url.searchParams.get("connection_limit")).toBe(String(REPORTING_POOL_DEFAULT));
    expect(url.searchParams.get("application_name")).toBe("neoxify-reporting");
  });

  it("fits inside Postgres's max_connections with room to spare (see the table in pool-url.ts)", () => {
    const maxConnections = 100; // measured on production, 2026-11-14
    const superuserReserved = 3;
    const retentionCli = 5;
    const migrate = 1;
    const psql = 2;
    const total = MAIN_POOL_DEFAULT + REPORTING_POOL_DEFAULT + retentionCli + migrate + psql + superuserReserved;
    expect(total).toBe(34);
    // A second backend container's worth during a deploy still fits.
    expect(total + MAIN_POOL_DEFAULT + REPORTING_POOL_DEFAULT).toBeLessThan(maxConnections);
  });

  it("leaves a missing URL missing, so Prisma reports it as before", () => {
    expect(withPool(undefined, mainPoolSettings({}))).toBeUndefined();
  });
});
