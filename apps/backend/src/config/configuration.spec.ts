import configuration from "./configuration";

/**
 * The exit-handle secret is read from two variables, the second a
 * fallback. docker-compose.prod.yml passes the first through as
 * `${EXIT_HANDLE_SECRET:-}`, so in production an unset value arrives as
 * the EMPTY STRING, not as undefined -- and a `??` fallback took the
 * empty string, which left every exit handle (and every per-ISP
 * attestation) null in production for six weeks.
 */
describe("security.exitHandleSecret", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("falls back to the credentials key when the variable is empty, as compose passes it", () => {
    process.env.EXIT_HANDLE_SECRET = "";
    process.env.CREDENTIALS_ENCRYPTION_KEY = "credentials-key";
    expect(configuration().security.exitHandleSecret).toBe("credentials-key");
  });

  it("falls back when the variable is absent", () => {
    delete process.env.EXIT_HANDLE_SECRET;
    process.env.CREDENTIALS_ENCRYPTION_KEY = "credentials-key";
    expect(configuration().security.exitHandleSecret).toBe("credentials-key");
  });

  it("prefers its own variable when it is set", () => {
    process.env.EXIT_HANDLE_SECRET = "own-secret";
    process.env.CREDENTIALS_ENCRYPTION_KEY = "credentials-key";
    expect(configuration().security.exitHandleSecret).toBe("own-secret");
  });
});

/** The same trap as above, in the Iran probe's numbers: blank from compose
 * became 0, so it probed port 0, kept no history and alerted on one
 * failure (October 2026). */
describe("reachability numbers", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it.each([undefined, "", "  ", "abc", "-1", "0", "1.5"])("uses the defaults for %p", (raw) => {
    for (const name of ["REACHABILITY_PORT", "REACHABILITY_FAILURES_BEFORE_ALERT", "REACHABILITY_RETENTION_DAYS"]) {
      if (raw === undefined) delete process.env[name];
      else process.env[name] = raw;
    }
    const { port, failuresBeforeAlert, retentionDays } = configuration().reachability;
    expect({ port, failuresBeforeAlert, retentionDays }).toEqual({ port: 443, failuresBeforeAlert: 2, retentionDays: 30 });
  });

  it("takes a value that is set", () => {
    process.env.REACHABILITY_PORT = "8443";
    process.env.REACHABILITY_FAILURES_BEFORE_ALERT = "3";
    process.env.REACHABILITY_RETENTION_DAYS = "14";
    const { port, failuresBeforeAlert, retentionDays } = configuration().reachability;
    expect({ port, failuresBeforeAlert, retentionDays }).toEqual({ port: 8443, failuresBeforeAlert: 3, retentionDays: 14 });
  });
});
