import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { ServiceTokenGuard } from "./service-token.guard";

describe("ServiceTokenGuard", () => {
  const configWith = (serviceToken?: string) =>
    ({ get: () => serviceToken }) as unknown as ConfigService;

  const contextWith = (header?: string | string[]) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ headers: { "x-service-token": header } }) }),
    }) as unknown as ExecutionContext;

  it("accepts the configured token", () => {
    const guard = new ServiceTokenGuard(configWith("s3cret"));
    expect(guard.canActivate(contextWith("s3cret"))).toBe(true);
  });

  it("rejects a wrong token", () => {
    const guard = new ServiceTokenGuard(configWith("s3cret"));
    expect(() => guard.canActivate(contextWith("nope"))).toThrow(UnauthorizedException);
  });

  /** A prefix must not pass. Comparing digests rather than raw strings is
   *  what makes length differences safe to handle at all. */
  it("rejects a token that is merely a prefix of the real one", () => {
    const guard = new ServiceTokenGuard(configWith("s3cret-and-then-some"));
    expect(() => guard.canActivate(contextWith("s3cret"))).toThrow(UnauthorizedException);
  });

  it("rejects a missing token", () => {
    const guard = new ServiceTokenGuard(configWith("s3cret"));
    expect(() => guard.canActivate(contextWith(undefined))).toThrow(/Missing service token/);
  });

  /** Fails closed: an unconfigured integration must be unreachable, never
   *  accidentally public. */
  it("rejects everything when no token is configured", () => {
    const guard = new ServiceTokenGuard(configWith(undefined));
    expect(() => guard.canActivate(contextWith("anything"))).toThrow(/not configured/);
    expect(() => guard.canActivate(contextWith(undefined))).toThrow(/not configured/);
  });

  it("handles a repeated header without crashing", () => {
    const guard = new ServiceTokenGuard(configWith("s3cret"));
    expect(guard.canActivate(contextWith(["s3cret", "other"]))).toBe(true);
  });
});
