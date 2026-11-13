import {
  assess,
  INSIDE_LOST_ROUNDS,
  insideFamily,
  parseTuning,
  unknownClientFamily,
  type FamilyResult,
  type InsideCheck,
} from "./block-signals";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-10-19T12:00:00Z");

describe("insideFamily", () => {
  // Rounds every 30 minutes, as the panel host's cron runs them. Two boxes
  // and three servers: "blocked" is the one under watch, "other-a" and
  // "other-b" stay reachable. Box "relay" moves data; box "signin"
  // connects and moves nothing to healthy servers, which is its normal
  // state -- only the connect is an input at all.
  const ROUND = 30 * MIN;
  const SERVERS = ["blocked", "other-a", "other-b"];
  type RoundState = Partial<Record<string, Partial<Record<string, boolean>>>>;

  /** `rounds` oldest first, the last just before NOW. A server a box has no
   * entry for connects. */
  function series(rounds: RoundState[], boxes = ["relay", "signin"]): InsideCheck[] {
    const out: InsideCheck[] = [];
    rounds.forEach((state, i) => {
      const at = NOW - (rounds.length - 1 - i) * ROUND - 5 * MIN;
      for (const box of boxes) {
        for (const nodeId of SERVERS) {
          out.push({ nodeId, vantage: box, connected: state[box]?.[nodeId] ?? true, checkedAt: at });
        }
      }
    });
    return out;
  }
  const healthy = (n: number): RoundState[] => Array.from({ length: n }, () => ({}));
  const lost = (n: number, boxes = ["relay", "signin"]): RoundState[] =>
    Array.from({ length: n }, () => Object.fromEntries(boxes.map((b) => [b, { blocked: false }])));
  const boxDown = (n: number, box: string): RoundState[] =>
    Array.from({ length: n }, () => ({ [box]: { blocked: false, "other-a": false, "other-b": false } }));

  it("is quiet and healthy while both boxes connect", () => {
    const f = insideFamily(series(healthy(48)), "blocked", NOW, 0);
    expect(f).toMatchObject({ family: "inside", firing: false, healthy: true, thin: false });
  });

  it("fires once both boxes lose the connection for the set rounds while other servers stay reachable", () => {
    const early = insideFamily(series([...healthy(48), ...lost(INSIDE_LOST_ROUNDS - 1)]), "blocked", NOW, 0);
    expect(early.firing).toBe(false);
    expect(early.healthy).toBe(false);

    const f = insideFamily(series([...healthy(48), ...lost(INSIDE_LOST_ROUNDS)]), "blocked", NOW, 0);
    expect(f.firing).toBe(true);
    expect(f.summary).toContain("relay and signin");
    expect(f.summary).toContain("still reached other servers");
    // Onset is the first lost round: 1.5 h before the fourth.
    expect(f.onset).toBe(NOW - (INSIDE_LOST_ROUNDS - 1) * ROUND - 5 * MIN);
    expect(f.summary).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("does not fire while one box that normally reaches it still connects", () => {
    const f = insideFamily(series([...healthy(48), ...lost(8, ["relay"])]), "blocked", NOW, 0);
    expect(f.firing).toBe(false);
    expect(f.healthy).toBe(false);
  });

  it("does not fire on a box that reaches nothing: that is the box, not a block", () => {
    const rounds = [...healthy(48), ...boxDown(8, "relay")];
    const alone = insideFamily(series(rounds, ["relay"]), "blocked", NOW, 0);
    expect(alone.firing).toBe(false);
    expect(alone.thin).toBe(true);
    // With the other box still connecting, it is healthy.
    const both = insideFamily(series(rounds), "blocked", NOW, 0);
    expect(both.firing).toBe(false);
    expect(both.healthy).toBe(true);
  });

  it("does not fire on the box that connects but moves nothing", () => {
    const f = insideFamily(series(healthy(56), ["signin"]), "blocked", NOW, 0);
    expect(f.firing).toBe(false);
    expect(f.healthy).toBe(true);
  });

  it("takes no evidence from a box that never reached the server", () => {
    const never = (n: number): RoundState[] => Array.from({ length: n }, () => ({ signin: { blocked: false } }));
    const f = insideFamily(series(never(56), ["signin"]), "blocked", NOW, 0);
    expect(f.firing).toBe(false);
    expect(f.thin).toBe(true);
    // The relay box, which normally reaches it, decides without it.
    const relayLost = never(56).map((r, i) => (i >= 56 - INSIDE_LOST_ROUNDS ? { ...r, relay: { blocked: false } } : r));
    expect(insideFamily(series(relayLost), "blocked", NOW, 0).firing).toBe(true);
  });

  it("is healthy again on recovery, even after a long block", () => {
    const f = insideFamily(series([...healthy(48), ...lost(60), ...healthy(1)]), "blocked", NOW, 0);
    expect(f.firing).toBe(false);
    expect(f.healthy).toBe(true);
  });

  it("says nothing on stale rounds, and nothing from before the owner's last answer", () => {
    const old = series([...healthy(48), ...lost(6)]).map((c) => ({ ...c, checkedAt: c.checkedAt - 4 * HOUR }));
    expect(insideFamily(old, "blocked", NOW, 0)).toMatchObject({ firing: false, thin: true });
    const floored = insideFamily(series([...healthy(48), ...lost(6)]), "blocked", NOW, NOW - 4 * HOUR);
    expect(floored.firing).toBe(false);
  });

  it("follows insideRounds from the settings", () => {
    const { tuning } = parseTuning("insideRounds=2");
    expect(insideFamily(series([...healthy(48), ...lost(2)]), "blocked", NOW, 0, tuning).firing).toBe(true);
  });
});

describe("assess with the inside family", () => {
  const family = (f: FamilyResult["family"], over: Partial<FamilyResult> = {}): FamilyResult => ({
    family: f,
    firing: false,
    thin: false,
    healthy: false,
    onset: null,
    summary: "",
    networks: [],
    ...over,
  });
  const base = { outage: null, previousSince: {}, now: NOW };

  it("is likely blocked with the outside check failing too, said in plain words", () => {
    const a = assess({
      ...base,
      client: family("client", { thin: true }),
      traffic: family("traffic", { thin: true }),
      probe: family("probe", { firing: true, onset: NOW - HOUR }),
      inside: family("inside", { firing: true, onset: NOW - 90 * MIN }),
    });
    expect(a.verdict).toBe("LIKELY_BLOCKED");
    expect(a.reason).toContain("our own boxes inside the country");
    expect(a.reason).toContain("the outside TCP check");
    expect(a.blockType).toBe("address");
    expect(a.since.inside).toBe(NOW - 90 * MIN);
  });

  it("is a suspicion on its own, while the outside check still connects", () => {
    const a = assess({
      ...base,
      client: family("client"),
      traffic: family("traffic"),
      probe: family("probe", { tcpOpen: true, healthy: true }),
      inside: family("inside", { firing: true, onset: NOW - 2 * HOUR }),
    });
    expect(a.verdict).toBe("SUSPECT");
  });
});

describe("unknownClientFamily", () => {
  it("is neither evidence nor thin, so the probe alone cannot page on it", () => {
    const client = unknownClientFamily("the network table has not loaded yet");
    expect(client).toMatchObject({ firing: false, thin: false, unknown: true, healthy: false });
    const a = assess({
      client,
      traffic: { family: "traffic", firing: false, thin: true, healthy: false, onset: null, summary: "", networks: [] },
      probe: { family: "probe", firing: true, thin: false, healthy: false, onset: NOW - 20 * HOUR, summary: "", networks: [] },
      outage: null,
      previousSince: { probe: NOW - 20 * HOUR },
      now: NOW,
    });
    expect(a.thinResidential).toBe(false);
    expect(a.verdict).toBe("SUSPECT");
  });
});
