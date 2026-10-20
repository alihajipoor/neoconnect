/** The account's side of the Activity page: its devices and its daily
 * usage, from the backend (docs/account-activity.md), as the page draws
 * them. Facts only, worded on screen.
 *
 * Both are the account's, read when the page opens, and neither is needed
 * to connect -- so neither goes over the relay, and a card that could not
 * be read says so (and offers to try again) rather than showing an empty
 * list or a zero. A backend that does not have them yet answers 404, and
 * is a card that could not be read like any other. */

import type { ApiResult } from "./api";
import type { AccountDevices, DailyUsage } from "./customer";
import { parseDevicePlatform } from "./device-identity";

/** How many days the usage card shows: two weeks fit the card's width. */
export const USAGE_DAYS = 14;

/** A card's data as it loads. */
export type Loadable<T> =
  | { readonly state: "loading" }
  | { readonly state: "ok"; readonly data: T }
  | { readonly state: "failed"; readonly noAnswer: boolean };

export function loadableFrom<T>(result: ApiResult<T>): Loadable<T> {
  if (result.ok) return { state: "ok", data: result.data };
  return { state: "failed", noAnswer: result.noResponse === true };
}

/** What signing another device out came to (`signOutDevice`):
 *  - `done`: it is signed out;
 *  - `alreadyGone`: it was not signed in any more (404) -- the list was
 *    stale, and is read again;
 *  - `thisDevice`: the server says it is this one (400 THIS_DEVICE), which
 *    the app's own sign-out does, not this;
 *  - `unreached`: nothing answered;
 *  - `failed`: anything else -- not done, and said so. */
export type DeviceSignOutOutcome = "done" | "alreadyGone" | "thisDevice" | "unreached" | "failed";

export function deviceSignOutOutcome(result: ApiResult<unknown>): DeviceSignOutOutcome {
  if (result.ok) return "done";
  if (result.noResponse) return "unreached";
  if (result.status === 404) return "alreadyGone";
  if (result.status === 400 && result.code === "THIS_DEVICE") return "thisDevice";
  return "failed";
}

/** Phones and computers look different on the list. */
export function deviceKind(platform: string | null): "phone" | "computer" | "unknown" {
  const parsed = parseDevicePlatform(platform);
  if (parsed === "android" || parsed === "ios") return "phone";
  if (parsed === "windows" || parsed === "macos" || parsed === "linux") return "computer";
  return "unknown";
}

/** Whether the list can say anything about which devices are in use:
 * only a yes, and only where the plan keeps track (docs: `inUseKnown`). */
export function inUseShown(devices: AccountDevices): boolean {
  return devices.inUseKnown;
}

export interface UsageBar {
  readonly date: string;
  readonly down: number;
  readonly up: number;
  readonly total: number;
}

export interface UsageChart {
  readonly bars: readonly UsageBar[];
  /** The largest day, for scaling; at least 1 so an empty fortnight draws
   * flat bars rather than dividing by zero. */
  readonly max: number;
  /** The period's total, summed exactly before it is turned into a number
   * for display. */
  readonly total: number;
  readonly today: UsageBar | null;
}

const DECIMAL = /^\d+$/;

/** A decimal string from the server, exactly; anything else is 0n -- which
 * is why no day reaches here that `usageReadable` has not passed. */
export function bytesOf(value: string): bigint {
  return DECIMAL.test(value) ? BigInt(value) : 0n;
}

/** Whether every day of a usage answer says its date and both counts as
 * the contract has them. One that does not -- null, a number, an error
 * string from something in between -- would otherwise be drawn as a day
 * of 0 bytes and lower the total, a number nothing measured. */
export function usageReadable(usage: unknown): usage is DailyUsage {
  if (usage === null || typeof usage !== "object") return false;
  const days = (usage as { days?: unknown }).days;
  if (!Array.isArray(days)) return false;
  return days.every((day: unknown) => {
    if (day === null || typeof day !== "object") return false;
    const { date, bytesDown, bytesUp } = day as Record<string, unknown>;
    return typeof date === "string" && typeof bytesDown === "string" && DECIMAL.test(bytesDown) && typeof bytesUp === "string" && DECIMAL.test(bytesUp);
  });
}

/** The usage card's data: an answer with any day it cannot read is the
 * card's "could not be read", never a chart. */
export function usageLoadable(result: ApiResult<DailyUsage>): Loadable<DailyUsage> {
  const loaded = loadableFrom(result);
  if (loaded.state === "ok" && !usageReadable(loaded.data)) return { state: "failed", noAnswer: false };
  return loaded;
}

export function usageChart(usage: DailyUsage): UsageChart {
  let sum = 0n;
  const bars = usage.days.map((day) => {
    const down = bytesOf(day.bytesDown);
    const up = bytesOf(day.bytesUp);
    sum += down + up;
    return { date: day.date, down: Number(down), up: Number(up), total: Number(down + up) };
  });
  return {
    bars,
    max: Math.max(1, ...bars.map((b) => b.total)),
    total: Number(sum),
    today: bars.length > 0 ? bars[bars.length - 1] : null,
  };
}

/** The device's own time zone, for days split at its own midnight;
 * UTC where the platform cannot say. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
