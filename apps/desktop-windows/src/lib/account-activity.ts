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

/** A decimal string from the server, exactly; anything else is 0n. */
export function bytesOf(value: string): bigint {
  return /^\d+$/.test(value) ? BigInt(value) : 0n;
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
