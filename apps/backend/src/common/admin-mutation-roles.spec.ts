import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ROLES_KEY } from "./decorators/roles.decorator";
import { RolesGuard } from "./guards/roles.guard";
import { ProtocolUsersController } from "../modules/protocol-users/protocol-users.controller";
import { RoutesController } from "../modules/routes/routes.controller";
import { SubscriptionsController } from "../modules/subscriptions/subscriptions.controller";

/** Admin mutations that decide who can use the VPN, or take a route down
 * for everyone, carry their roles in the API and not only in the panel.
 *
 * With no @Roles, JwtAuthGuard lets every staff role through except
 * RESELLER, so a SUPPORT login could create a paid subscription, mint or
 * re-enable a credential on an unpaid or suspended one, and create or
 * delete a route -- the panel merely hid the buttons. */
describe("admin mutation roles", () => {
  const cases: [string, object, string, string[]][] = [
    ["POST /subscriptions", SubscriptionsController.prototype, "create", ["SUPERADMIN", "BILLING"]],
    ["POST /protocol-users", ProtocolUsersController.prototype, "create", ["SUPERADMIN", "BILLING"]],
    ["PATCH /protocol-users/:id/enabled", ProtocolUsersController.prototype, "setEnabled", ["SUPERADMIN", "BILLING"]],
    ["DELETE /protocol-users/:id", ProtocolUsersController.prototype, "remove", ["SUPERADMIN", "BILLING"]],
    ["POST /routes", RoutesController.prototype, "create", ["SUPERADMIN"]],
    ["DELETE /routes/:id", RoutesController.prototype, "remove", ["SUPERADMIN"]],
  ];

  it.each(cases)("%s is limited to its roles, enforced by RolesGuard", (_route, proto, method, roles) => {
    const handler = (proto as Record<string, unknown>)[method] as object;
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(roles);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RolesGuard);
  });
});
