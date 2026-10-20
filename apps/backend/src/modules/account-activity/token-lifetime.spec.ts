import { tokenLifetimeMs } from "./token-lifetime";

/** CUSTOMER_JWT_REFRESH_TTL read the way jsonwebtoken reads it, so the
 * device list leaves out exactly the sessions whose refresh token has run
 * out. */
describe("tokenLifetimeMs", () => {
  const DAY = 86_400_000;

  it.each([
    ["7d", 7 * DAY],
    ["30d", 30 * DAY],
    ["12h", 12 * 3_600_000],
    ["2 days", 2 * DAY],
    ["90m", 90 * 60_000],
    ["1w", 7 * DAY],
    ["45s", 45_000],
    ["1.5h", 5_400_000],
  ])("reads %j", (value, expected) => {
    expect(tokenLifetimeMs(value)).toBe(expected);
  });

  it("reads a bare number in a string as milliseconds, as jsonwebtoken does", () => {
    expect(tokenLifetimeMs("604800")).toBe(604_800);
  });

  it("reads a number as seconds, as jsonwebtoken does", () => {
    expect(tokenLifetimeMs(604_800)).toBe(7 * DAY);
  });

  it.each([undefined, null, "", "forever", "7 fortnights", "-7d", "0d", "d"])("gives null for %j", (value) => {
    expect(tokenLifetimeMs(value)).toBeNull();
  });
});
