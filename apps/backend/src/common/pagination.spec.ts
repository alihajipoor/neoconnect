import { listWindow, sendPage, wholeList, TOTAL_COUNT_HEADER } from "./pagination";
import type { Response } from "express";

const LIMITS = { defaultTake: 100, maxTake: 500 };

describe("listWindow", () => {
  it("applies the default when nothing is asked for", () => {
    expect(listWindow({}, LIMITS)).toEqual({ take: 100, skip: 0 });
  });

  it("honours an explicit take below the cap", () => {
    expect(listWindow({ take: "25" }, LIMITS)).toEqual({ take: 25, skip: 0 });
  });

  /** The point of the whole exercise. A caller asking for the table is
   * given a page, not the table. */
  it("clamps a take above the cap", () => {
    expect(listWindow({ take: "100000" }, LIMITS).take).toBe(500);
  });

  it("clamps the cap even when take arrives as a number", () => {
    expect(listWindow({ take: 99_999 }, LIMITS).take).toBe(500);
  });

  it("carries skip through for paging", () => {
    expect(listWindow({ take: "50", skip: "200" }, LIMITS)).toEqual({ take: 50, skip: 200 });
  });

  /** Garbage falls back to the default rather than erroring. An
   * operator's page load is not worth failing over a bad query string,
   * and the clamp means a bad value can never widen the window. */
  it.each([
    ["not a number", "banana"],
    ["negative", "-5"],
    ["zero", "0"],
    ["a float", "12.5"],
    ["trailing junk that parseInt would accept", "100abc"],
    ["empty", ""],
    ["null", null],
    ["undefined", undefined],
  ])("falls back to the default when take is %s", (_label, value) => {
    expect(listWindow({ take: value }, LIMITS).take).toBe(100);
  });

  /** `Number("1e9")` is 1,000,000,000 and a perfectly good integer, so
   * it is not garbage and does not fall back -- it is clamped, like any
   * other over-large take. Worth pinning: `Number.parseInt("1e9")` reads
   * it as **1**, which would silently hand back a one-row page, and that
   * is the reason this parser does not use parseInt. */
  it("clamps exponent notation rather than reading it as 1", () => {
    expect(listWindow({ take: "1e9" }, LIMITS).take).toBe(500);
  });

  it("treats a bad skip as no skip", () => {
    expect(listWindow({ skip: "-3" }, LIMITS).skip).toBe(0);
  });
});

describe("sendPage", () => {
  it("returns the bare array and puts the total in a header", () => {
    const headers: Record<string, string> = {};
    const res = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
    } as unknown as Response;

    const body = sendPage(res, { items: [{ id: "a" }, { id: "b" }], total: 1480 });

    // The body must stay a bare array: shipped clients parse it directly
    // and an envelope would break every one of them.
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([{ id: "a" }, { id: "b" }]);
    // The total is the count before the window, not the page length --
    // the panel's stat cards read this and printing 2 would be a lie.
    expect(headers[TOTAL_COUNT_HEADER]).toBe("1480");
  });
});

describe("wholeList", () => {
  it("reports the length as the total, with no second query", () => {
    expect(wholeList([1, 2, 3])).toEqual({ items: [1, 2, 3], total: 3 });
  });
});
