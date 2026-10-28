import "reflect-metadata";
import { EventEmitter } from "node:events";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ROLES_KEY } from "../../common/decorators/roles.decorator";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { SiteVisitsController } from "./site-visits.controller";

/** A customer's site history is the owner's to read, and every read is
 * on record. */
describe("GET /customers/:id/sites", () => {
  it("is SUPERADMIN only, enforced by RolesGuard behind JwtAuthGuard", () => {
    const handler = (SiteVisitsController.prototype as unknown as Record<string, unknown>).sites as object;
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(["SUPERADMIN"]);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RolesGuard);
    expect(Reflect.getMetadata(GUARDS_METADATA, SiteVisitsController)).toContain(JwtAuthGuard);
  });

  it("writes who looked, at which customer, to the admin audit once the answer has gone out", async () => {
    const view = { retentionDays: 7, coverage: "", total: 0, sites: [] };
    const siteVisits = { sites: jest.fn().mockResolvedValue(view) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const controller = new SiteVisitsController(siteVisits as any, audit as any);
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    const req = { method: "GET", originalUrl: "/customers/0b7c/sites?q=tele&days=2", url: "/x", ip: "198.51.100.4" };
    const admin = { sub: "admin-1", email: "owner@example.test", role: "SUPERADMIN" };

    await expect(controller.sites("0b7c", admin as any, req as any, res as any, "2", "tele", undefined)).resolves.toBe(view);
    expect(siteVisits.sites).toHaveBeenCalledWith("0b7c", { days: "2", q: "tele", take: undefined });
    expect(audit.record).not.toHaveBeenCalled();

    res.emit("finish");
    expect(audit.record).toHaveBeenCalledWith({
      adminId: "admin-1",
      email: "owner@example.test",
      role: "SUPERADMIN",
      method: "GET",
      path: "/customers/0b7c/sites",
      status: 200,
      ip: "198.51.100.4",
    });
  });
});
