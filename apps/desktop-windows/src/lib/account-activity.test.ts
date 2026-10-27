import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { bytesOf, deviceKind, deviceSignOutOutcome, loadableFrom, usageChart, usageLoadable, usageReadable } from "./account-activity";
import type { AccountDevices, DailyUsage } from "./customer";
import { I18nProvider } from "./i18n";
import { formatDay } from "./locale-format";
import { ActivityView, deviceListName, type ActivityData, type SessionLogView } from "../screens/Activity";

const USAGE: DailyUsage = {
  subscriptionId: null,
  timeZone: "Asia/Tehran",
  from: "2026-10-18",
  to: "2026-10-20",
  asOf: "2026-10-20T08:00:00.000Z",
  days: [
    { date: "2026-10-18", bytesUp: "0", bytesDown: "0" },
    { date: "2026-10-19", bytesUp: "18341120", bytesDown: "734003200" },
    { date: "2026-10-20", bytesUp: "9007199254740993", bytesDown: "1" },
  ],
};

const DEVICES: AccountDevices = {
  inUseKnown: true,
  devices: [
    {
      id: "a",
      thisDevice: true,
      label: null,
      platform: "windows",
      signedInAt: "2026-10-02T09:14:07.000Z",
      lastSeenAt: "2026-10-20T07:58:30.000Z",
      inUse: { since: "2026-10-20T07:02:11.000Z", lastSeen: "2026-10-20T07:58:30.000Z" },
    },
    {
      id: "b",
      thisDevice: false,
      label: "Pixel 7",
      platform: "android",
      signedInAt: "2026-09-28T17:40:00.000Z",
      lastSeenAt: "2026-10-19T07:21:44.000Z",
      inUse: null,
    },
  ],
};

const DATA: ActivityData = { history: {}, network: null, routes: [], subscription: null, savedAt: null };
const NOW = Date.parse("2026-10-20T08:00:00.000Z");

function render(props: Partial<Parameters<typeof ActivityView>[0]>): string {
  return renderToStaticMarkup(
    createElement(I18nProvider, null, createElement(ActivityView, { data: DATA, now: NOW, ...props })),
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
}

describe("daily usage", () => {
  it("sums the days exactly, past 2^53, before showing them", () => {
    expect(bytesOf("9007199254740993") + 1n).toBe(9007199254740994n);
    const chart = usageChart(USAGE);
    expect(chart.bars).toHaveLength(3);
    expect(chart.bars[0].total).toBe(0);
    expect(chart.bars[1]).toMatchObject({ down: 734003200, up: 18341120 });
    expect(chart.today?.date).toBe("2026-10-20");
    expect(chart.max).toBeGreaterThan(9e15);
  });

  it("reads anything but a decimal string as nothing", () => {
    expect(bytesOf("-5")).toBe(0n);
    expect(bytesOf("1e9")).toBe(0n);
  });

  it("calls an answer with one malformed day unreadable, never a 0-byte day", () => {
    expect(usageLoadable({ ok: true, data: USAGE })).toEqual({ state: "ok", data: USAGE });
    for (const bad of [null, 5, "error", "-1", "1e9", undefined]) {
      const days = [USAGE.days[0], { ...USAGE.days[1], bytesDown: bad }, USAGE.days[2]];
      const data = { ...USAGE, days } as unknown as typeof USAGE;
      expect(usageReadable(data), String(bad)).toBe(false);
      expect(usageLoadable({ ok: true, data }), String(bad)).toEqual({ state: "failed", noAnswer: false });
    }
    expect(usageReadable({ days: "none" })).toBe(false);
    expect(usageReadable({ ...USAGE, days: [null] })).toBe(false);
  });

  it("names days in the reader's calendar without moving them across midnight", () => {
    expect(formatDay("2026-10-19", "en")).toBe("19 Oct");
    // Solar Hijri: 1405-07-27.
    expect(formatDay("2026-10-19", "fa")).toContain("۲۷");
  });

  it("says it is as recorded, and never claims to be the plan's total", () => {
    const text = render({ usage: { state: "ok", data: USAGE }, devices: { state: "ok", data: DEVICES } });
    expect(text).toContain("as Neoxify's servers recorded it");
    expect(text).toContain("don't add up to your plan's total");
    expect(text).toContain("Today so far");
  });

  it("says when it could not be read, and offers to try again -- never a zero", () => {
    const text = render({
      usage: { state: "failed", noAnswer: true },
      devices: { state: "failed", noAnswer: false },
      onRetryDevices: () => undefined,
      onRetryUsage: () => undefined,
    });
    expect(text).toContain("Couldn't reach Neoxify for your daily usage.");
    expect(text).toContain("Neoxify couldn't list your devices right now.");
    expect(text.match(/Try again/g)?.length).toBe(2);
    expect(text).not.toMatch(/0 B/);
  });
});

describe("devices on the plan", () => {
  it("lists them with this device marked, and in use only where the plan says so", () => {
    const text = render({ devices: { state: "ok", data: DEVICES } });
    expect(text).toContain("Windows PC This device");
    expect(text).toContain("Pixel 7");
    expect(text.match(/In use now/g)?.length).toBe(2); // the hint, and the one device
  });

  it("says nothing is known about use where the plan keeps no track, rather than implying none is in use", () => {
    const text = render({ devices: { state: "ok", data: { inUseKnown: false, devices: [{ ...DEVICES.devices[1] }] } } });
    expect(text).toContain("Your plan doesn't keep track of which devices are connected");
  });

  it("offers no way to sign another device out until the owner decides", () => {
    const text = render({ devices: { state: "ok", data: DEVICES } });
    expect(text).not.toMatch(/sign out of this device|sign this device out|sign out pixel/i);
    // Built, and switched off: no app passes the switch yet (owner decision
    // pending, docs/account-activity.md).
    for (const app of ["../App.tsx", "../../../mobile/src/App.tsx", "../../../web-portal/src/App.tsx"]) {
      expect(readFileSync(new URL(app, import.meta.url), "utf8"), app).not.toMatch(/deviceSignOut/);
    }
  });

  it("once approved, offers Sign out on the other devices only, never this one", () => {
    const html = renderToStaticMarkup(
      createElement(
        I18nProvider,
        null,
        createElement(ActivityView, {
          data: DATA,
          now: NOW,
          devices: { state: "ok", data: DEVICES },
          onSignOutDevice: async () => "done" as const,
        }),
      ),
    );
    expect(html.match(/data-device-signout=""/g)?.length).toBe(1);
    expect(html).toContain('aria-label="Sign out Pixel 7"');
    const thisRow = html.slice(html.indexOf('data-device="this"'), html.indexOf("</li>", html.indexOf('data-device="this"')));
    expect(thisRow).not.toContain("data-device-signout");
  });

  it("says what signing a device out came to", () => {
    expect(deviceSignOutOutcome({ ok: true, data: undefined })).toBe("done");
    expect(deviceSignOutOutcome({ ok: false, error: "x", status: 404 })).toBe("alreadyGone");
    expect(deviceSignOutOutcome({ ok: false, error: "x", status: 400, code: "THIS_DEVICE" })).toBe("thisDevice");
    expect(deviceSignOutOutcome({ ok: false, error: "x", noResponse: true })).toBe("unreached");
    expect(deviceSignOutOutcome({ ok: false, error: "x", status: 429 })).toBe("failed");
    expect(deviceSignOutOutcome({ ok: false, error: "x", status: 400 })).toBe("failed");
  });

  it("names a device by its own label, or its kind", () => {
    const t = (key: string) => ({ "act.devAndroid": "Android phone", "act.devUnknown": "Another device" })[key] ?? key;
    expect(deviceListName({ label: "Android phone (Galaxy S24)", platform: "android" }, t as never)).toBe("Galaxy S24");
    expect(deviceListName({ label: null, platform: "android" }, t as never)).toBe("Android phone");
    expect(deviceListName({ label: null, platform: "toaster" }, t as never)).toBe("Another device");
    expect(deviceKind("ios")).toBe("phone");
    expect(deviceKind("windows")).toBe("computer");
    expect(deviceKind(null)).toBe("unknown");
  });

  it("are read as failed for an answer that is not one", () => {
    expect(loadableFrom({ ok: false, error: "x", noResponse: true })).toEqual({ state: "failed", noAnswer: true });
    expect(loadableFrom({ ok: false, error: "x", status: 404 })).toEqual({ state: "failed", noAnswer: false });
  });
});

describe("the session log on the page", () => {
  const log = (over: Partial<SessionLogView> = {}): SessionLogView => ({
    enabled: false,
    loaded: true,
    records: [],
    onEnabled: () => undefined,
    onClear: () => undefined,
    ...over,
  });

  it("is offered only where the platform records it", () => {
    expect(render({})).not.toContain("Keep a session log on this device");
    expect(render({ log: log() })).toContain("Keep a session log on this device");
  });

  it("says it is off by default, local, seven days, readable by whoever opens the device -- and that connect results are still reported", () => {
    const text = render({ log: log() });
    expect(text).toContain("Off by default");
    expect(text).toContain("7 days");
    expect(text).toContain("Anyone who can open this device can read it");
    expect(text).toContain("Connection results are still reported");
  });

  it("lists what it holds, newest first, with a lost one said and an unseen end said as unknown", () => {
    const text = render({
      log: log({
        enabled: true,
        records: [
          { id: "1", start: NOW - 7_200_000, end: null, open: false, routeId: null, protocol: "WIREGUARD", rxBytes: null, txBytes: null, ended: null },
          { id: "2", start: NOW - 3_600_000, end: NOW - 1_800_000, open: false, routeId: null, protocol: "WIREGUARD", rxBytes: 2048, txBytes: 1024, ended: "lost" },
        ],
      }),
    });
    expect(text.indexOf("Lost")).toBeLessThan(text.indexOf("end not recorded"));
    expect(text).toContain("2.0 KB down, 1.0 KB up");
    expect(text).toContain("Clear the session log");
  });

  it("says when nothing has been recorded yet", () => {
    expect(render({ log: log({ enabled: true }) })).toContain("Nothing recorded yet");
  });
});
