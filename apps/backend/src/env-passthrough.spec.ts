import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deviceCredentialLimit } from "./modules/protocol-users/protocol-users.service";
import { concurrencyCutMode, deviceSlotsMode } from "./modules/device-slots/modes";

/** A value in infra/.env reaches Compose's interpolation, NOT the
 * container, unless the backend's `environment:` block names it. That gap
 * has bitten three times already (the billing keys, the social sign-in
 * keys, and CUSTOMER_DEVICE_CREDENTIAL_LIMIT, which an operator could set
 * and never see take effect). Every tuning knob read by code is listed
 * here, and each must be passed through as `${NAME:-}` -- optional, empty
 * meaning "the default in the code". */
const OPTIONAL_KNOBS = ["CUSTOMER_DEVICE_CREDENTIAL_LIMIT", "CONCURRENCY_CUT", "DEVICE_SLOTS"];

const COMPOSE = readFileSync(join(__dirname, "..", "..", "..", "infra", "docker-compose.prod.yml"), "utf8");

describe("infra/docker-compose.prod.yml passes the backend's optional knobs through", () => {
  it.each(OPTIONAL_KNOBS)("%s", (name) => {
    expect(COMPOSE).toContain(`${name}: \${${name}:-}`);
  });
});

/** The coordinator's defaults: the backstop watches (shadow) until a week
 * of logs says it can act, and slots are on -- they affect only apps
 * that claim. A typo must land on the default, not on the other mode. */
describe("CONCURRENCY_CUT and DEVICE_SLOTS", () => {
  const saved = { cut: process.env.CONCURRENCY_CUT, slots: process.env.DEVICE_SLOTS };
  afterEach(() => {
    for (const [name, value] of [
      ["CONCURRENCY_CUT", saved.cut],
      ["DEVICE_SLOTS", saved.slots],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it.each([undefined, "", "  ", "shadow", "SHADOW", "enforcee", "on"])("CONCURRENCY_CUT=%j is shadow", (value) => {
    if (value === undefined) delete process.env.CONCURRENCY_CUT;
    else process.env.CONCURRENCY_CUT = value;
    expect(concurrencyCutMode()).toBe("shadow");
  });

  it("CONCURRENCY_CUT=enforce enforces", () => {
    process.env.CONCURRENCY_CUT = " Enforce ";
    expect(concurrencyCutMode()).toBe("enforce");
  });

  it.each([undefined, "", "enforce", "of", "disabled"])("DEVICE_SLOTS=%j enforces", (value) => {
    if (value === undefined) delete process.env.DEVICE_SLOTS;
    else process.env.DEVICE_SLOTS = value;
    expect(deviceSlotsMode()).toBe("enforce");
  });

  it("DEVICE_SLOTS=off grants everything", () => {
    process.env.DEVICE_SLOTS = "OFF";
    expect(deviceSlotsMode()).toBe("off");
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
