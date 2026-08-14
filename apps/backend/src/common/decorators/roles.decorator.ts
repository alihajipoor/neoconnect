import { SetMetadata } from "@nestjs/common";
import { AdminRole } from "@prisma/client";

export const ROLES_KEY = "roles";
export const Roles = (...roles: AdminRole[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Every admin role, for the handful of endpoints that are genuinely
 * self-service: read your own account, turn your own MFA on, sign out.
 *
 * Needed because JwtAuthGuard now denies outsider roles (RESELLER) on
 * any endpoint that declares no @Roles(). A reseller must still be able
 * to manage their own login, so those routes say so explicitly instead
 * of relying on a default -- and saying so is now the only way to be
 * reachable by one.
 *
 * Built from a `Record<AdminRole, true>` rather than `Object.values()`
 * so that adding a role to the Prisma enum is a COMPILE error here. A
 * new role silently inheriting "everyone" is the exact mistake RESELLER
 * made once already; the same trick guards the panel's protocol list.
 */
const EVERY_ADMIN_ROLE: Record<AdminRole, true> = {
  SUPERADMIN: true,
  SUPPORT: true,
  BILLING: true,
  RESELLER: true,
};

export const ALL_ADMIN_ROLES = Object.keys(EVERY_ADMIN_ROLE) as AdminRole[];
