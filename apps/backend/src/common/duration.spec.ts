import { durationSeconds } from "./duration";

describe("durationSeconds", () => {
  it.each([
    ["90s", 90],
    ["45m", 2_700],
    ["1h", 3_600],
    [" 12H ", 43_200],
    ["7d", 604_800],
    ["600", 600],
  ])("%j is %d seconds", (raw, seconds) => {
    expect(durationSeconds(raw, 1)).toBe(seconds);
  });

  it.each([undefined, null, "", "  ", "0h", "1w", "1.5h", "-1h", "soon"])("%j falls back", (raw) => {
    expect(durationSeconds(raw, 42)).toBe(42);
  });
});
