import type { PrismaService } from "../../prisma/prisma.service";
import { tokenMatches } from "./inside-probe.controller";
import { insideSummary, insideVerdict, PROBE_BYTES } from "./inside-probe";
import { InsideProbeService } from "./inside-probe.service";

const leg = (status: number, bytes: number, ms: number) => ({ status, bytes, ms });
const DONE = leg(200, PROBE_BYTES, 900);

describe("insideVerdict", () => {
  it("passes a node that moved both ways in time", () => {
    expect(insideVerdict(40, DONE, DONE)).toBe("moves");
  });

  /** Measured from ir2 on 15 October 2026: the first 63-95 KB of an upload
   * go through at once, then about 0.1 Mbps. curl gives up at its time
   * limit having sent what it could, with no answer. */
  it("calls a held upload slow", () => {
    expect(insideVerdict(40, DONE, leg(0, 160_000, 8_000))).toBe("slow");
  });

  it("calls a connection that opened and carried nothing slow, not unreachable", () => {
    expect(insideVerdict(40, leg(0, 0, 8_000), leg(0, 0, 8_000))).toBe("slow");
  });

  it("calls no connection at all unreachable", () => {
    expect(insideVerdict(null, leg(0, 0, 5_000), leg(0, 0, 5_000))).toBe("unreachable");
  });
});

describe("insideSummary", () => {
  const at = new Date("2026-10-27T12:00:00Z");
  const row = (nodeName: string, vantage: string, verdict: string, upBytes = PROBE_BYTES, upMs = 900) => ({
    nodeName,
    vantage,
    verdict,
    upBytes,
    upMs,
    checkedAt: at,
  });

  it("names a node that failed from a box on at least half its checks, with the upload it managed", () => {
    const rows = [
      row("uk-1", "ir2", "slow", 100_000, 8_000),
      row("uk-1", "ir2", "slow", 100_000, 8_000),
      row("uk-1", "ir2", "moves"),
      row("uk-1", "signin", "moves"),
      row("germany-1", "ir2", "moves"),
    ];
    expect(insideSummary(rows)).toEqual(["uk-1 from ir2: failed 2 of 3 checks -- connects, but the upload managed about 100 kbps"]);
  });

  it("says when there was no connection at all", () => {
    expect(insideSummary([row("fi", "signin", "unreachable", 0, 0)])).toEqual([
      "fi from signin: failed 1 of 1 checks -- no connection",
    ]);
  });

  it("is empty when most checks moved", () => {
    expect(insideSummary([row("uk-1", "ir2", "moves"), row("uk-1", "ir2", "moves"), row("uk-1", "ir2", "slow")])).toEqual([]);
  });
});

describe("tokenMatches", () => {
  const token = "x".repeat(40);
  it("refuses everything while no long token is set", () => {
    expect(tokenMatches(undefined, token)).toBe(false);
    expect(tokenMatches("short", "short")).toBe(false);
  });
  it("takes only the exact token", () => {
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(token, `${token}y`)).toBe(false);
    expect(tokenMatches(token, undefined)).toBe(false);
  });
});

describe("InsideProbeService.record", () => {
  it("stores a round with its verdicts, dropping nodes that no longer exist, and prunes old checks", async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 1 });
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      node: { findMany: jest.fn().mockResolvedValue([{ id: "n1" }]) },
      insideProbeCheck: { createMany, deleteMany },
    } as unknown as PrismaService;
    const now = new Date("2026-10-27T12:00:00Z");
    const stored = await new InsideProbeService(prisma).record(
      "ir2",
      [
        { nodeId: "n1", port: 2053, connectMs: 40, down: DONE, up: leg(0, 90_000, 8_000) },
        { nodeId: "gone", port: 2053, connectMs: 40, down: DONE, up: DONE },
      ],
      now,
    );
    expect(stored).toBe(1);
    expect(createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({ nodeId: "n1", vantage: "ir2", verdict: "slow", upBytes: 90_000, checkedAt: now }),
    ]);
    expect((deleteMany.mock.calls[0][0].where.checkedAt.lt as Date).getTime()).toBe(now.getTime() - 30 * 86_400_000);
  });
});
