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

  it("GET insight, attempts, usage and history: on the same guarded controller, any staff role", () => {
    for (const name of ["insight", "attempts", "usage", "history"]) {
      const h = handler(CustomerActivityController.prototype, name);
      expect(typeof h).toBe("function");
      expect(Reflect.getMetadata(ROLES_KEY, h)).toBeUndefined();
      expect(Reflect.getMetadata("path", h)).toBe(`:id/${name}`);
    }
  });

  it("passes the caller to history and the total in X-Total-Count", async () => {
    const insights = {
      history: jest.fn().mockResolvedValue({ items: [{ type: "ACCOUNT_CREATED" }], total: 7 }),
      attempts: jest.fn().mockResolvedValue({ items: [], total: 3 }),
    };
    const controller = new CustomerActivityController({} as never, insights as never);
    const res = { setHeader: jest.fn() };
    const admin = { sub: "a", email: "staff@example.com", role: "SUPPORT" };
    await expect(controller.history("id", admin as never, res as never, "10", "0")).resolves.toEqual([{ type: "ACCOUNT_CREATED" }]);
    expect(insights.history).toHaveBeenCalledWith("id", { take: "10", skip: "0" }, admin);
    expect(res.setHeader).toHaveBeenCalledWith("X-Total-Count", "7");
    await controller.attempts("id", { category: "api" }, res as never);
    expect(insights.attempts).toHaveBeenCalledWith("id", { category: "api" });
    expect(res.setHeader).toHaveBeenCalledWith("X-Total-Count", "3");
  });

  it("POST /customers/:id/sessions/:sessionId/sign-out: SUPERADMIN and SUPPORT, enforced by RolesGuard", () => {
    const signOut = handler(CustomerActivityController.prototype, "signOut");
    expect(Reflect.getMetadata(ROLES_KEY, signOut)).toEqual(["SUPERADMIN", "SUPPORT"]);
    expect(guardsOf(signOut)).toContain(RolesGuard);
  });
});
