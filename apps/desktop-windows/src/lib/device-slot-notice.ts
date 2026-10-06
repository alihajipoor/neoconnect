import type { Language, TranslationKey } from "./i18n";
import type { DeviceLimitRefusal, SlotDevice } from "./device-slots";
import { parseDevicePlatform, specificDeviceLabel, type DevicePlatform } from "./device-identity";

/** What the screen says about the plan's device limit, in the app's
 * language.
 *
 * The server's `message` is an English fallback and is never shown: the
 * card is worded here from the limit and the holders (docs/device-slots.md,
 * obligation 3). Pure, so both clients word it identically and the
 * wording is tested without a screen.
 */

export type SlotNotice =
  /** Refused before dialling, or by a claim made once the tunnel was up. */
  | { kind: "refused"; refusal: DeviceLimitRefusal }
  /** Another device took the slot over, or got it after this one went
   * quiet. */
  | { kind: "displaced"; by: SlotDevice | null; at: string | null }
  /** 429: too many takeovers on this subscription in the last hour. */
  | { kind: "takeoverLimited"; retryAfterSec: number | null }
  /** A degraded tunnel on a device whose slot was never confirmed, and
   * the API could not be asked whether the limit is the reason. Said
   * before the ladder runs, not instead of it (obligation 9). */
  | { kind: "unchecked"; limit: number };

export interface SlotNoticeCopy {
  /** The sentences, in order. */
  lines: string[];
  /** "Use on this device instead", with the handles a takeover names --
   * every one shown, so the server frees exactly as many as it needs,
   * least recently seen first. Null when there is nothing to take over. */
  useHere: { label: string; takeover: string[] } | null;
  /** The way out without acting: Cancel on a refusal, Dismiss elsewhere.
   * Null for a note that is not a choice. */
  dismiss: string | null;
}

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

export interface NoticeContext {
  t: Translate;
  language: Language;
  /** Whether the tunnel is confirmed down. "Disconnected:" is a claim
   * about the tunnel, and it is only made when the service has said so. */
  tunnelDown: boolean;
  /** For "today" versus an earlier day. */
  now?: number;
  /** The time zone to format in. The device's own when omitted. */
  timeZone?: string;
  /** The locale to format times in. Persian for a Persian screen, the
   * device's own otherwise. */
  locale?: string;
}

/** A device's kind, in the app's language, for a device the server names
 * by its platform alone. */
const PLATFORM_NAMES: Record<DevicePlatform, TranslationKey> = {
  windows: "slots.platformWindows",
  macos: "slots.platformMac",
  linux: "slots.platformLinux",
  android: "slots.platformAndroid",
  ios: "slots.platformIos",
};

/** Keeps a left-to-right name intact inside a right-to-left sentence.
 * Without the isolate, "Galaxy S24 (work)" in Persian comes out with its
 * parenthesis on the wrong side. */
function isolate(name: string, language: Language): string {
  return language === "fa" && /[A-Za-z0-9]/.test(name) ? `⁨${name}⁩` : name;
}

/** How a device is named on this screen (docs/device-slots.md, "Naming a
 * device on screen").
 *
 * Its `label` when it has one -- a model or the user's own words, shown
 * as sent. Otherwise its kind, from `platform`, in the app's language:
 * the server sends no kind as a label any more, because the device that
 * named itself may not read the language this one does. With neither,
 * "another device". A label that is only a kind, from a server before
 * that, is read the same way: the kind is named here. */
export function deviceName(
  device: Pick<SlotDevice, "label" | "platform"> | null,
  ctx: Pick<NoticeContext, "t" | "language">,
): string {
  const label = specificDeviceLabel(device?.label);
  if (label !== null) return isolate(label, ctx.language);
  const platform = parseDevicePlatform(device?.platform);
  return ctx.t(platform ? PLATFORM_NAMES[platform] : "slots.anotherDevice");
}

/** A time in the device's locale and time zone: the time alone if it
 * is today, the date as well if not. Persian in Persian digits and the
 * Persian calendar, which is what a customer in Iran reads. Null for a
 * time that cannot be read, which drops "since ..." rather than
 * inventing one. */
export function formatSlotTime(
  iso: string | null,
  ctx: Pick<NoticeContext, "language" | "now" | "timeZone" | "locale">,
): string | null {
  if (iso === null) return null;
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  const locale = ctx.locale ?? (ctx.language === "fa" ? "fa-IR" : undefined);
  const zone = ctx.timeZone ? { timeZone: ctx.timeZone } : {};
  try {
    const day = new Intl.DateTimeFormat("en-CA", { ...zone, year: "numeric", month: "2-digit", day: "2-digit" });
    const today = day.format(new Date(ctx.now ?? Date.now())) === day.format(at);
    return new Intl.DateTimeFormat(locale, {
      ...zone,
      ...(today ? {} : { month: "short", day: "numeric" }),
      hour: "2-digit",
      minute: "2-digit",
    }).format(at);
  } catch {
    // A time zone this runtime does not know. Not worth a card without
    // the sentence it belongs to.
    return null;
  }
}

/** A count in the sentence's own digits, so a Persian card does not mix
 * "۰۳:۵۰" with "2". */
function count(n: number, ctx: Pick<NoticeContext, "language">): string {
  return ctx.language === "fa" ? n.toLocaleString("fa-IR") : String(n);
}

function refusalLines(refusal: DeviceLimitRefusal, ctx: NoticeContext): string[] {
  const lines: string[] = [];
  if (refusal.limit === 1) lines.push(ctx.t("slots.limitOne"));
  else if (refusal.limit !== null) lines.push(ctx.t("slots.limitMany", { limit: count(refusal.limit, ctx) }));

  const holders = refusal.holders;
  if (holders.length === 0) {
    lines.push(ctx.t("slots.inUseOnNoTime", { device: ctx.t("slots.anotherDevice") }));
  } else if (holders.length === 1) {
    const device = deviceName(holders[0], ctx);
    const time = formatSlotTime(holders[0].since, ctx);
    lines.push(time ? ctx.t("slots.inUseOn", { device, time }) : ctx.t("slots.inUseOnNoTime", { device }));
  } else {
    const devices = holders
      .map((h) => {
        const device = deviceName(h, ctx);
        const time = formatSlotTime(h.since, ctx);
        return time ? ctx.t("slots.deviceSince", { device, time }) : device;
      })
      .join(ctx.language === "fa" ? "، " : ", ");
    lines.push(ctx.t("slots.inUseOnMany", { devices }));
  }
  return lines;
}

export function describeSlotNotice(notice: SlotNotice, ctx: NoticeContext): SlotNoticeCopy {
  switch (notice.kind) {
    case "refused":
      return {
        lines: refusalLines(notice.refusal, ctx),
        useHere: { label: ctx.t("slots.useHere"), takeover: notice.refusal.holders.map((h) => h.handle) },
        dismiss: ctx.t("slots.cancel"),
      };
    case "displaced": {
      const device = deviceName(notice.by, ctx);
      const handle = notice.by?.handle ?? null;
      return {
        lines: [ctx.t(ctx.tunnelDown ? "slots.displaced" : "slots.nowInUseOn", { device })],
        // Without a handle there is nobody to name, and a plain connect
        // asks the same question.
        useHere: { label: ctx.t("slots.useHere"), takeover: handle ? [handle] : [] },
        dismiss: ctx.t("slots.dismiss"),
      };
    }
    case "takeoverLimited": {
      // The window is an hour, so an hour is the honest upper bound when
      // the server did not say.
      const minutes = Math.max(1, Math.ceil((notice.retryAfterSec ?? 3600) / 60));
      return {
        lines: [ctx.t("slots.takeoverLimit", { minutes: count(minutes, ctx) })],
        useHere: null,
        dismiss: ctx.t("slots.dismiss"),
      };
    }
    case "unchecked":
      return { lines: [ctx.t("slots.unchecked", { limit: count(notice.limit, ctx) })], useHere: null, dismiss: null };
  }
}
