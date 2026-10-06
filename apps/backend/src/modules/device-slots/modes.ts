import { Logger } from "@nestjs/common";

/** The two switches for the plan's device limit, read at call time so an
 * operator can flip them with `docker compose up -d` and no rebuild.
 * Empty (as compose passes an unset `${VAR:-}`) means the default; an
 * unrecognised value means the default too, with a warning once. */

/** The node-side backstop (ConcurrencyService):
 *
 * * `shadow` (default): works out per device who it would hold and logs
 *   "would hold device X", and sends nothing. Combined with per-device
 *   credentials, the old subscription-wide cut would disconnect
 *   customers who were only switching devices, and it has never been
 *   observed working against a real node -- so it watches first.
 * * `enforce`: holds the device it picked -- a targeted DISABLE_USER on
 *   its credentials, kept off the 60 s re-assert by a lease that lapses
 *   on its own once there is room again. */
export type ConcurrencyCutMode = "shadow" | "enforce";

/** Device slots (DeviceSlotsService), the plan's limit as the apps ask
 * for it before connecting:
 *
 * * `enforce` (default): a claim past the plan's limit is refused with
 *   409 DEVICE_LIMIT. Only clients that claim are affected -- the
 *   releases that implement docs/device-slots.md.
 * * `off`: every claim is granted and nothing is recorded. */
export type DeviceSlotsMode = "enforce" | "off";

const warned = new Set<string>();

function read<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  if (raw === "") return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  if (!warned.has(`${name}=${raw}`)) {
    warned.add(`${name}=${raw}`);
    new Logger("DeviceLimit").warn(`${name}=${JSON.stringify(raw)} is not one of ${allowed.join("|")}; using ${fallback}`);
  }
  return fallback;
}

export function concurrencyCutMode(): ConcurrencyCutMode {
  return read("CONCURRENCY_CUT", ["shadow", "enforce"] as const, "shadow");
}

export function deviceSlotsMode(): DeviceSlotsMode {
  return read("DEVICE_SLOTS", ["enforce", "off"] as const, "enforce");
}
