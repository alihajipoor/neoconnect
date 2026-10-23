import { Logger } from "@nestjs/common";

/** "Sign out of another device" (DELETE /customer/devices/:id), behind
 * ACCOUNT_DEVICE_SIGNOUT until the owner has decided it.
 *
 * Off (the default, and anything not "on"): the route answers 404, as if
 * it did not exist, so a deploy that must precede the client release does
 * not hand every customer token the power to revoke the account's other
 * sessions and take their credentials off the nodes before anyone chose
 * that. "on" with the one-line change in the app's App.tsx that passes
 * `deviceSignOut` (docs/account-activity.md).
 *
 * Read at call time, as the device-limit switches are (device-slots/
 * modes.ts), so `docker compose up -d` flips it with no rebuild. */
export function deviceSignOutEnabled(): boolean {
  const raw = (process.env.ACCOUNT_DEVICE_SIGNOUT ?? "").trim().toLowerCase();
  if (raw === "" || raw === "off") return false;
  if (raw === "on") return true;
  if (!warned) {
    warned = true;
    new Logger("AccountActivity").warn(`ACCOUNT_DEVICE_SIGNOUT=${JSON.stringify(raw)} is not one of on|off; using off`);
  }
  return false;
}

let warned = false;
