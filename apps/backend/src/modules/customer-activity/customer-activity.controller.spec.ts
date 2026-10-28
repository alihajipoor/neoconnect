import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ROLES_KEY } from "../../common/decorators/roles.decorator";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { CustomerActivityController, MonitorController } from "./customer-activity.controller";

/** Who may see a customer's connections, and who may sign their devices
 * out. With no @Roles, JwtAuthGuard lets every staff role through and
 * refuses a reseller -- the same as GET /customers/:id, which is what
 * the reads mirror. */
describe("customer activity roles", () => {
  const guardsOf = (target: object) => (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[]) ?? [];
  const handler = (proto: object, name: string) => (proto as Record<string, unknown>)[name] as object;

  it("GET /customers/:id/activity and GET /monitor/live: any staff role, as GET /customers/:id", () => {
    expect(guardsOf(CustomerActivityController)).toContain(JwtAuthGuard);
    expect(guardsOf(MonitorController)).toContain(JwtAuthGuard);
    expect(Reflect.getMetadata(ROLES_KEY, handler(CustomerActivityController.prototype, "get"))).toBeUndefined();
    expect(Reflect.getMetadata(ROLES_KEY, handler(MonitorController.prototype, "live"))).toBeUndefined();
  });

  it("POST /customers/:id/sessions/:sessionId/sign-out: SUPERADMIN and SUPPORT, enforced by RolesGuard", () => {
    const signOut = handler(CustomerActivityController.prototype, "signOut");
    expect(Reflect.getMetadata(ROLES_KEY, signOut)).toEqual(["SUPERADMIN", "SUPPORT"]);
    expect(guardsOf(signOut)).toContain(RolesGuard);
  });
});
