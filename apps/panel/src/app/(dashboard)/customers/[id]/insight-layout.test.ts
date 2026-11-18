import { describe, expect, it } from "vitest";
import type { InsightFailure } from "@/lib/types";
import {
  dayColumns,
  dayHeading,
  findingFilters,
  groupByUtcDay,
  hourColumns,
  percent,
  ratioTone,
  topFailure,
  utcClock,
} from "./insight-layout";

const failure = (code: InsightFailure["code"], count: number): InsightFailure => ({
  code,
  label: code,
  count,
  lastAt: "2026-11-18T10:00:00.000Z",
  example: "",
});

describe("ratioTone and percent", () => {
  it("tells nothing, none, some and all apart", () => {
    expect(ratioTone(0, 0)).toBe("empty");
    expect(ratioTone(0, 6)).toBe("none");
    expect(ratioTone(6, 7)).toBe("some");
    expect(ratioTone(7, 7)).toBe("all");
  });
  it("rounds to a whole percent and has none without a whole", () => {
    expect(percent(6, 7)).toBe(86);
    expect(percent(0, 6)).toBe(0);
    expect(percent(3, 0)).toBeNull();
  });
});

describe("topFailure", () => {
  it("is null with no failures", () => {
    expect(topFailure([])).toBeNull();
  });
  it("picks the largest count and says how many share it", () => {
    const result = topFailure([failure("TOO_SLOW", 2), failure("NOT_CARRYING", 6), failure("API_UNREACHABLE", 6)]);
    expect(result?.failure.code).toBe("NOT_CARRYING");
    expect(result?.tiedWith).toBe(1);
  });
});

describe("findingFilters", () => {
  it("takes the network a network finding names first", () => {
    expect(
      findingFilters({ code: "NETWORK_SPECIFIC", title: "Fails on Example Mobile (AS64500), connects elsewhere" }),
    ).toEqual({ asn: "64500" });
    expect(findingFilters({ code: "NETWORK_OTHERS_OK", title: "Others connect on AS64501; this customer did not" })).toEqual({
      asn: "64501",
    });
  });
  it("maps causes, the app and a never-connected account to the log", () => {
    expect(findingFilters({ code: "API_UNREACHABLE_OFTEN", title: "" })).toEqual({ failureCode: "API_UNREACHABLE" });
    expect(findingFilters({ code: "OTHER_VPN", title: "" })).toEqual({ failureCode: "OTHER_VPN_ACTIVE" });
    expect(findingFilters({ code: "NOT_CARRYING_OFTEN", title: "" })).toEqual({ outcome: "NOT_CARRYING_TRAFFIC" });
    expect(findingFilters({ code: "APP_BEHIND", title: "android app is not the newest release" })).toEqual({
      platform: "android",
    });
    expect(findingFilters({ code: "NEVER_CONNECTED", title: "" })).toEqual({});
  });
  it("has no link for findings that are not about reports", () => {
    expect(findingFilters({ code: "PLAN_EXPIRED", title: "The plan has expired" })).toBeNull();
    expect(findingFilters({ code: "NETWORK_SPECIFIC", title: "no network named" })).toBeNull();
  });
});

describe("hourColumns", () => {
  const now = Date.parse("2026-11-18T10:30:00.000Z");
  it("has one column an hour up to 72 hours, oldest first, ending with the current hour", () => {
    const columns = hourColumns(
      [
        { hour: "2026-11-18T10:00:00.000Z", nodeName: "a", protocol: "x", bytesUp: "5", bytesDown: "10" },
        { hour: "2026-11-18T10:00:00.000Z", nodeName: "b", protocol: "x", bytesUp: "1", bytesDown: "2" },
        { hour: "2026-11-17T11:00:00.000Z", nodeName: "a", protocol: "x", bytesUp: "3", bytesDown: "4" },
        { hour: "2026-11-01T00:00:00.000Z", nodeName: "a", protocol: "x", bytesUp: "9", bytesDown: "9" },
      ],
      24,
      now,
    );
    expect(columns).toHaveLength(24);
    expect(columns[0].start).toBe("2026-11-17T11:00:00.000Z");
    expect(columns[0]).toMatchObject({ up: 3, down: 4, hours: 1 });
    expect(columns[23]).toMatchObject({ start: "2026-11-18T10:00:00.000Z", up: 6, down: 12 });
    expect(columns.slice(1, 23).every((c) => c.up === 0 && c.down === 0)).toBe(true);
  });
  it("folds a longer window into wider columns", () => {
    expect(hourColumns([], 168, now)).toHaveLength(84);
    expect(hourColumns([], 168, now)[0].hours).toBe(2);
    expect(hourColumns([], 336, now)).toHaveLength(84);
  });
});

describe("dayColumns", () => {
  it("covers every UTC day in the window, oldest first", () => {
    const now = Date.parse("2026-11-18T10:30:00.000Z");
    const columns = dayColumns(
      [{ day: "2026-11-17", nodeName: "a", protocol: "x", bytesUp: "1", bytesDown: "2" }],
      3,
      now,
    );
    expect(columns.map((c) => c.start.slice(0, 10))).toEqual(["2026-11-16", "2026-11-17", "2026-11-18"]);
    expect(columns[1]).toMatchObject({ up: 1, down: 2 });
  });
});

describe("groupByUtcDay and the day's labels", () => {
  it("groups consecutive items under their UTC day", () => {
    const groups = groupByUtcDay([
      { at: "2026-11-18T23:59:00.000Z" },
      { at: "2026-11-18T01:00:00.000Z" },
      { at: "2026-11-17T22:00:00.000Z" },
    ]);
    expect(groups.map((g) => [g.day, g.items.length])).toEqual([
      ["2026-11-18", 2],
      ["2026-11-17", 1],
    ]);
  });
  it("names the day and the UTC time", () => {
    expect(dayHeading("2026-11-18")).toBe("Wed 18 Nov 2026");
    expect(utcClock("2026-11-18T14:03:59.000Z")).toBe("14:03");
  });
});
