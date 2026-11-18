import { describe, expect, it } from "vitest";
import {
  cellTone,
  failStageText,
  parseCheckHours,
  percentText,
  reachableTotals,
  serviceChecksHref,
  serviceOrder,
} from "./service-check-layout";

describe("service-check layout", () => {
  it("orders the known services first, then keys the list does not have", () => {
    const known = [
      { key: "instagram", label: "Instagram" },
      { key: "google", label: "Google" },
    ];
    expect(serviceOrder(known, ["google", "old_target", "instagram", "old_target"])).toEqual([
      { key: "instagram", label: "Instagram" },
      { key: "google", label: "Google" },
      { key: "old_target", label: "old_target" },
    ]);
  });

  it("marks a cell red only under half reachable over at least three results", () => {
    expect(cellTone(0, 0)).toBe("empty");
    expect(cellTone(0, 2)).toBe("some"); // two failures are not a pattern yet
    expect(cellTone(1, 2)).toBe("problem");
    expect(cellTone(0, 3)).toBe("problem");
    expect(cellTone(2, 2)).toBe("some"); // exactly half is not under half
    expect(cellTone(5, 0)).toBe("all");
  });

  it("sums reachable and all results", () => {
    expect(
      reachableTotals([
        { perService: [{ ok: 3, failed: 1 }, { ok: 2, failed: 0 }] },
        { perService: [{ ok: 0, failed: 4 }] },
      ]),
    ).toEqual({ ok: 5, total: 10 });
    expect(reachableTotals([])).toEqual({ ok: 0, total: 0 });
  });

  it("never rounds a partial share to all or none", () => {
    expect(percentText(1196, 1287)).toBe("93%");
    expect(percentText(999, 1000)).toBe(">99%");
    expect(percentText(1, 1000)).toBe("<1%");
    expect(percentText(5, 5)).toBe("100%");
    expect(percentText(0, 5)).toBe("0%");
    expect(percentText(0, 0)).toBe("");
  });

  it("says one failure apart from several", () => {
    expect(failStageText(1, "name lookup")).toBe("failed at name lookup");
    expect(failStageText(4, "the reply")).toBe("most failed at the reply");
  });

  it("reads and builds the window", () => {
    expect(parseCheckHours("168")).toBe(168);
    expect(parseCheckHours("72")).toBe(24);
    expect(parseCheckHours(undefined)).toBe(24);
    expect(serviceChecksHref(24)).toBe("/service-checks");
    expect(serviceChecksHref(168)).toBe("/service-checks?hours=168");
  });
});
