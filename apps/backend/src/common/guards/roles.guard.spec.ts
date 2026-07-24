import { ExecutionContext } from "@nestjs/common";
import { ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RolesGuard } from "./roles.guard";

function buildContext(user: { role: string } | undefined): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

describe("RolesGuard", () => {
  it("allows access when the route declares no @Roles() at all", () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(buildContext({ role: "SUPPORT" }))).toBe(true);
  });

  it("allows access when the user's role is in the required list", () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(["SUPERADMIN", "BILLING"]) } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(buildContext({ role: "BILLING" }))).toBe(true);
  });

  it("throws ForbiddenException when the user's role is not in the required list", () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(["SUPERADMIN"]) } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(buildContext({ role: "SUPPORT" }))).toThrow(ForbiddenException);
  });

  it("throws ForbiddenException when there is no authenticated user at all", () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(["SUPERADMIN"]) } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(buildContext(undefined))).toThrow(ForbiddenException);
  });
});
