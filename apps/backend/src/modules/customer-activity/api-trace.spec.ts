import { parseApiTrace } from "./api-trace";

describe("parseApiTrace", () => {
  it("reads legs, doors, cut marks and the probe section", () => {
    const trace = parseApiTrace(
      "req: a.example=h401@820 b.example:2053=cancel@830; refresh: a.example=timeout@8001; door: 192.0.2.7:2053=pin@310; [3 cut]; probe: a.example=dns@40 b.example:2053=tls@310",
    );
    expect(trace).toEqual({
      entries: [
        { leg: "req", target: "a.example", outcome: "h401", ms: 820 },
        { leg: "req", target: "b.example:2053", outcome: "cancel", ms: 830 },
        { leg: "refresh", target: "a.example", outcome: "timeout", ms: 8001 },
        { leg: "door", target: "192.0.2.7:2053", outcome: "pin", ms: 310 },
      ],
      probe: "a.example=dns@40 b.example:2053=tls@310",
      noneDialled: false,
      cut: 3,
    });
  });

  it("says none dialled, and keeps a probe that was skipped", () => {
    expect(parseApiTrace("none dialled; probe: skipped=connect")).toEqual({
      entries: [],
      probe: "skipped=connect",
      noneDialled: true,
      cut: 0,
    });
  });

  it("reads an older client's hostname list as entries with no outcome", () => {
    expect(parseApiTrace("a.example, b.example:2053")?.entries).toEqual([
      { leg: null, target: "a.example", outcome: null, ms: null },
      { leg: null, target: "b.example:2053", outcome: null, ms: null },
    ]);
  });

  it("keeps an entry it cannot read as its text, and returns null for nothing", () => {
    expect(parseApiTrace("req: ???")?.entries).toEqual([{ leg: "req", target: "???", outcome: null, ms: null }]);
    expect(parseApiTrace(null)).toBeNull();
    expect(parseApiTrace("  ")).toBeNull();
  });
});
