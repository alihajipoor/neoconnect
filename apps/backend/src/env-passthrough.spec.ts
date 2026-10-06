import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deviceCredentialLimit } from "./modules/protocol-users/protocol-users.service";

/** A value in infra/.env reaches Compose's interpolation, NOT the
 * container, unless the backend's `environment:` block names it. That gap
 * has bitten three times already (the billing keys, the social sign-in
 * keys, and CUSTOMER_DEVICE_CREDENTIAL_LIMIT, which an operator could set
 * and never see take effect). Every tuning knob read by code is listed
 * here, and each must be passed through as `${NAME:-}` -- optional, empty
 * meaning "the default in the code". */
const OPTIONAL_KNOBS = ["CUSTOMER_DEVICE_CREDENTIAL_LIMIT", "CONCURRENCY_CUT"];

const COMPOSE = readFileSync(join(__dirname, "..", "..", "..", "infra", "docker-compose.prod.yml"), "utf8");

describe("infra/docker-compose.prod.yml passes the backend's optional knobs through", () => {
  it.each(OPTIONAL_KNOBS)("%s", (name) => {
    expect(COMPOSE).toContain(`${name}: \${${name}:-}`);
  });
});

describe("CUSTOMER_DEVICE_CREDENTIAL_LIMIT", () => {
  const saved = process.env.CUSTOMER_DEVICE_CREDENTIAL_LIMIT;
  afterEach(() => {
    if (saved === undefined) delete process.env.CUSTOMER_DEVICE_CREDENTIAL_LIMIT;
    else process.env.CUSTOMER_DEVICE_CREDENTIAL_LIMIT = saved;
  });

  // Owner decision, 2026-10-06: a hidden cap of ten (it was five).
  it("defaults to ten when unset", () => {
    delete process.env.CUSTOMER_DEVICE_CREDENTIAL_LIMIT;
    expect(deviceCredentialLimit()).toBe(10);
  });

  // What `${CUSTOMER_DEVICE_CREDENTIAL_LIMIT:-}` delivers when .env has no value.
  it.each(["", "   "])("treats %j, as compose passes an unset value, as the default", (value) => {
    process.env.CUSTOMER_DEVICE_CREDENTIAL_LIMIT = value;
    expect(deviceCredentialLimit()).toBe(10);
  });

  it.each([
    ["3", 3],
    [" 7 ", 7],
    ["50", 50],
  ])("accepts %j", (value, expected) => {
    process.env.CUSTOMER_DEVICE_CREDENTIAL_LIMIT = value;
    expect(deviceCredentialLimit()).toBe(expected);
  });

  // "1e6" and "0x7fffffff" both used to be accepted, switching off the cap
  // that keeps one account from filling a WireGuard pool.
  it.each(["0", "-1", "2.5", "abc", "1e6", "0x7fffffff", "51"])("ignores %j in favour of the default", (value) => {
    process.env.CUSTOMER_DEVICE_CREDENTIAL_LIMIT = value;
    expect(deviceCredentialLimit()).toBe(10);
  });
});
