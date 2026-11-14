import { describe, expect, it } from "vitest";
import { grantOf, trustedCookieOptions, trustedIdCookieOptions } from "./trusted-device-cookie";

const NOW = Date.UTC(2026, 10, 14);
const in30Days = new Date(NOW + 30 * 24 * 3600 * 1000).toISOString();

describe("the trusted-device cookies", () => {
  it("keep the token from scripts, other sites and every path but the sign-in", () => {
    expect(trustedCookieOptions(in30Days, true, NOW)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/login",
      maxAge: 30 * 24 * 3600,
    });
  });

  it("are Secure only when asked (production)", () => {
    expect(trustedCookieOptions(in30Days, false, NOW).secure).toBe(false);
  });

  it("last until the fixed expiry and never more than 30 days", () => {
    const in3Days = new Date(NOW + 3 * 24 * 3600 * 1000).toISOString();
    expect(trustedCookieOptions(in3Days, true, NOW).maxAge).toBe(3 * 24 * 3600);
    const in90Days = new Date(NOW + 90 * 24 * 3600 * 1000).toISOString();
    expect(trustedCookieOptions(in90Days, true, NOW).maxAge).toBe(30 * 24 * 3600);
    expect(trustedCookieOptions(new Date(NOW - 1000).toISOString(), true, NOW).maxAge).toBe(0);
    expect(trustedCookieOptions("not a date", true, NOW).maxAge).toBe(0);
  });

  it("keep the device's id HttpOnly too", () => {
    expect(trustedIdCookieOptions(in30Days, true, NOW)).toMatchObject({ httpOnly: true, secure: true, path: "/" });
  });

  it("accept only a well-formed grant", () => {
    expect(grantOf({ token: "t", id: "i", expiresAt: in30Days, extra: 1 })).toEqual({ token: "t", id: "i", expiresAt: in30Days });
    expect(grantOf(undefined)).toBeUndefined();
    expect(grantOf({ token: 1, id: "i", expiresAt: in30Days })).toBeUndefined();
  });
});
