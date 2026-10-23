import { describe, expect, it } from "vitest";
import { cookieOptions, needsRenewal, secondsLeft } from "./session-tokens";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const token = (expInSeconds: number | null) => {
  const claims = expInSeconds === null ? { sub: "a" } : { sub: "a", exp: Math.floor(NOW / 1000) + expInSeconds };
  return `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
};

describe("needsRenewal", () => {
  it("renews a missing or nearly spent access token while the refresh token lives", () => {
    expect(needsRenewal(undefined, token(3_000), NOW)).toBe(true);
    expect(needsRenewal(token(60), token(3_000), NOW)).toBe(true);
    expect(needsRenewal(token(-5), token(3_000), NOW)).toBe(true);
    expect(needsRenewal("garbage", token(3_000), NOW)).toBe(true);
  });

  it("leaves a fresh access token alone", () => {
    expect(needsRenewal(token(600), token(3_000), NOW)).toBe(false);
  });

  it("does nothing without a live refresh token: the page sends the person to sign in", () => {
    expect(needsRenewal(undefined, undefined, NOW)).toBe(false);
    expect(needsRenewal(undefined, token(-1), NOW)).toBe(false);
    expect(needsRenewal(undefined, token(null), NOW)).toBe(false);
  });
});

describe("cookieOptions", () => {
  it("lives as long as the token", () => {
    expect(cookieOptions(token(900), true, NOW)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 900,
    });
    expect(secondsLeft(token(3_600), NOW)).toBe(3_600);
  });
});
