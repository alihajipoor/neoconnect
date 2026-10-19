import { addDays, canonicalTimeZone, dailyTotals, localDate, type UsageBucket } from "./daily-usage";

/** The day arithmetic behind GET /customer/subscriptions/:id/usage. Most
 * customers are in Iran, where midnight is 20:30 UTC: a history bucketed
 * by the UTC hour, or by a fixed offset, puts the half hour either side of
 * it on the wrong day. */

const at = (iso: string) => Date.parse(iso) / 1000;
const bucket = (iso: string, up: bigint, down: bigint): UsageBucket => ({ startSec: at(iso), bytesUp: up, bytesDown: down });

describe("localDate", () => {
  it("puts Tehran's midnight at 20:30 UTC", () => {
    expect(localDate(new Date("2026-10-19T20:15:00Z"), "Asia/Tehran")).toBe("2026-10-19");
    expect(localDate(new Date("2026-10-19T20:29:59Z"), "Asia/Tehran")).toBe("2026-10-19");
    expect(localDate(new Date("2026-10-19T20:30:00Z"), "Asia/Tehran")).toBe("2026-10-20");
  });

  it("follows a zone across its daylight-saving change, by the tz database rather than a fixed offset", () => {
    // Berlin leaves summer time on 25 October 2026: midnight is 22:00 UTC
    // before it and 23:00 UTC after.
    expect(localDate(new Date("2026-10-24T21:45:00Z"), "Europe/Berlin")).toBe("2026-10-24");
    expect(localDate(new Date("2026-10-24T22:00:00Z"), "Europe/Berlin")).toBe("2026-10-25");
    expect(localDate(new Date("2026-10-25T22:45:00Z"), "Europe/Berlin")).toBe("2026-10-25");
    expect(localDate(new Date("2026-10-25T23:00:00Z"), "Europe/Berlin")).toBe("2026-10-26");
  });

  it("handles a zone a quarter hour off the hour", () => {
    // Kathmandu is +05:45.
    expect(localDate(new Date("2026-10-19T18:00:00Z"), "Asia/Kathmandu")).toBe("2026-10-19");
    expect(localDate(new Date("2026-10-19T18:15:00Z"), "Asia/Kathmandu")).toBe("2026-10-20");
  });

  it("answers in Gregorian Latin digits whatever the zone", () => {
    expect(localDate(new Date("2026-03-20T21:00:00Z"), "Asia/Tehran")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("addDays", () => {
  it.each([
    ["2026-10-19", 1, "2026-10-20"],
    ["2026-10-31", 1, "2026-11-01"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2028-02-28", 1, "2028-02-29"],
    ["2026-03-01", -1, "2026-02-28"],
    ["2026-10-20", -29, "2026-09-21"],
  ])("%s %+d is %s", (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });
});

describe("canonicalTimeZone", () => {
  it("accepts IANA names and canonicalises their case", () => {
    expect(canonicalTimeZone("Asia/Tehran")).toBe("Asia/Tehran");
    expect(canonicalTimeZone("asia/tehran")).toBe("Asia/Tehran");
    expect(canonicalTimeZone("UTC")).toBe("UTC");
  });

  it.each(["", "Mars/Olympus_Mons", "Asia/Tehran; DROP TABLE", "x".repeat(65)])("refuses %j", (value) => {
    expect(canonicalTimeZone(value)).toBeNull();
  });
});

describe("dailyTotals", () => {
  it("splits the quarter hours either side of Tehran's midnight onto their own days", () => {
    const days = dailyTotals(
      [
        bucket("2026-10-19T20:15:00Z", 100n, 1_000n), // 23:45 on the 19th
        bucket("2026-10-19T20:30:00Z", 5n, 50n), //       00:00 on the 20th
      ],
      "Asia/Tehran",
      "2026-10-19",
      "2026-10-20",
    );
    expect(days).toEqual([
      { date: "2026-10-19", bytesUp: "100", bytesDown: "1000" },
      { date: "2026-10-20", bytesUp: "5", bytesDown: "50" },
    ]);
  });

  it("gives every day in the range a total, oldest first, 0 where nothing was recorded", () => {
    const days = dailyTotals([bucket("2026-10-17T08:00:00Z", 1n, 2n)], "UTC", "2026-10-15", "2026-10-19");
    expect(days.map((d) => d.date)).toEqual(["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"]);
    expect(days.map((d) => [d.bytesUp, d.bytesDown])).toEqual([
      ["0", "0"],
      ["0", "0"],
      ["1", "2"],
      ["0", "0"],
      ["0", "0"],
    ]);
  });

  it("drops buckets outside the range rather than folding them into its ends", () => {
    const days = dailyTotals(
      [bucket("2026-10-14T20:00:00Z", 7n, 7n), bucket("2026-10-20T20:30:00Z", 9n, 9n)],
      "Asia/Tehran",
      "2026-10-15",
      "2026-10-20",
    );
    expect(days.every((d) => d.bytesUp === "0" && d.bytesDown === "0")).toBe(true);
  });

  it("adds exactly past 2^53 bytes", () => {
    const days = dailyTotals(
      [bucket("2026-10-19T01:00:00Z", 0n, 9_007_199_254_740_993n), bucket("2026-10-19T02:00:00Z", 0n, 1n)],
      "UTC",
      "2026-10-19",
      "2026-10-19",
    );
    expect(days[0].bytesDown).toBe("9007199254740994");
  });
});
