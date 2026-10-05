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
