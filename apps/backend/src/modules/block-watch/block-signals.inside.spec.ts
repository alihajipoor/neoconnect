import {
  assess,
  bytesFamily,
  bytesMayCount,
  INSIDE_LOST_ROUNDS,
  INSIDE_SILENT_AFTER_MS,
  insideFamily,
  parseTuning,
  settleOneNetwork,
  unknownClientFamily,
  type FamilyResult,
  type InsideCheck,
} from "./block-signals";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse("2026-10-19T12:00:00Z");

describe("insideFamily", () => {
  // Rounds every 30 minutes, as the panel host's cron runs them. Two boxes
  // and six servers: "blocked" is the one under watch, "other-a" to
  // "other-e" stay reachable. Box "relay" moves data wherever it connects;
  // box "signin" connects and moves nothing, which is its normal state for
  // several healthy servers (and was, through two real blocks).
  const ROUND = 30 * MIN;
  const OTHERS = ["other-a", "other-b", "other-c", "other-d", "other-e"];
  const SERVERS = ["blocked", ...OTHERS];
  /** false: no connection; "empty": a connection that moved nothing. */
  type RoundState = Partial<Record<string, Partial<Record<string, boolean | "empty">>>>;

  /** `rounds` oldest first, the last just before NOW. A server a box has no
   * entry for connects, and moves data if the box is a mover. */
  function series(rounds: RoundState[], boxes = ["relay", "signin"], movers = ["relay"]): InsideCheck[] {
    const out: InsideCheck[] = [];
    rounds.forEach((state, i) => {
      const at = NOW - (rounds.length - 1 - i) * ROUND - 5 * MIN;
      for (const box of boxes) {
        for (const nodeId of SERVERS) {
          const value = state[box]?.[nodeId] ?? true;
          const connected = value !== false;
          const moved = value === true && movers.includes(box);
          out.push({ nodeId, vantage: box, connected, moved, checkedAt: at });
        }
      }
    });
    return out;
  }
  /** Rounds in which these boxes connect to "blocked" and move nothing. */
  const empty = (n: number, boxes = ["relay"]): RoundState[] =>
    Array.from({ length: n }, () => Object.fromEntries(boxes.map((b) => [b, { blocked: "empty" as const }])));
  const healthy = (n: number): RoundState[] => Array.from({ length: n }, () => ({}));
  const lost = (n: number, boxes = ["relay", "signin"]): RoundState[] =>
    Array.from({ length: n }, () => Object.fromEntries(boxes.map((b) => [b, { blocked: false }])));
  const boxDown = (n: number, box: string): RoundState[] =>
    Array.from({ length: n }, () => ({ [box]: Object.fromEntries(SERVERS.map((s) => [s, false])) }));

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
    expect(f.summary).toContain("still reached most of the other servers");
    // Onset is the first lost round: 1.5 h before the fourth.
    expect(f.onset).toBe(NOW - (INSIDE_LOST_ROUNDS - 1) * ROUND - 5 * MIN);
    expect(f.summary).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("fires on one box's lost connection while another still moves data to it, and says so as partial", () => {
    // Until 2026-11-17 the other box vetoed this; now it is the scope.
    const f = insideFamily(series([...healthy(48), ...lost(8, ["signin"])]), "blocked", NOW, 0);
    expect(f.firing).toBe(true);
    expect(f.healthy).toBe(false);
    expect(f.lostTcp).toBe(true);
    expect(f.scope).toMatchObject({ kind: "partial", partial: true, lost: ["signin"], working: ["relay"] });
    expect(f.scope!.text).toBe("from 1 of 2 inside networks (signin); still moves data from relay");
    expect(f.summary).toContain("signin could not open a connection");
    expect(f.summary).toContain(f.scope!.text);
    // One round in which the mover moved nothing is not a loss.
    expect(insideFamily(series([...healthy(48), ...empty(1)]), "blocked", NOW, 0).firing).toBe(false);
  });

  it("fires when the box that moves data loses it while the other only connects with nothing moving (10-28, 11-07)", () => {
    // The shape of both missed blocks: one box lost the connect for hours
    // while the sign-in box kept connecting with 0 bytes, its normal.
    const f = insideFamily(series([...healthy(48), ...lost(INSIDE_LOST_ROUNDS, ["relay"])]), "blocked", NOW, 0);
    expect(f.firing).toBe(true);
    expect(f.summary).toContain("relay could not open a connection");
    expect(f.summary).toContain("signin still connects but moves no data to it");
    expect(insideFamily(series([...healthy(48), ...lost(INSIDE_LOST_ROUNDS - 1, ["relay"])]), "blocked", NOW, 0).firing).toBe(
      false,
    );
    expect(insideFamily(series([...healthy(48), ...lost(INSIDE_LOST_ROUNDS, ["relay"])]), "blocked", NOW, 0).scope).toMatchObject({
      kind: "some",
      partial: false,
      text: "from 1 of 2 inside networks (relay); signin shows it neither working nor lost",
    });
    // A box that connects AND moves data in its latest round shows it
    // working, even one that did not move data before: partial now.
    const signinMovesNow = series([...healthy(48), ...lost(INSIDE_LOST_ROUNDS, ["relay"])]).map((c) =>
      c.vantage === "signin" && c.nodeId === "blocked" && c.checkedAt === NOW - 5 * MIN ? { ...c, moved: true } : c,
    );
    const partial = insideFamily(signinMovesNow, "blocked", NOW, 0);
    expect(partial.firing).toBe(true);
    expect(partial.scope).toMatchObject({ kind: "partial", working: ["signin"] });
  });

  it("counts a mover's rounds that connect and move nothing as lost (uk-1, 2026-11-14)", () => {
    const early = insideFamily(series([...healthy(48), ...empty(INSIDE_LOST_ROUNDS - 1)]), "blocked", NOW, 0);
    expect(early.firing).toBe(false);
    expect(early.healthy).toBe(false);
    expect(early.summary).toContain("relay lost it in the latest check (3 in a row so far)");

    const f = insideFamily(series([...healthy(48), ...empty(INSIDE_LOST_ROUNDS)]), "blocked", NOW, 0);
    expect(f.firing).toBe(true);
    expect(f.lostTcp).toBe(false);
    expect(f.onset).toBe(NOW - (INSIDE_LOST_ROUNDS - 1) * ROUND - 5 * MIN);
    expect(f.summary).toContain("relay connects to this server but moved no data either way for 4 checks in a row");
    expect(f.summary).toContain("moved data to others it usually moves data to");
    // signin connects and never moves data to it: no proof either way.
    expect(f.scope).toMatchObject({ kind: "some", lost: ["relay"], working: [] });
    // A bare connect from a mover is no longer the server working.
    expect(f.healthy).toBe(false);
  });

  it("never counts a non-mover's empty rounds", () => {
    // signin connects and moves nothing everywhere: its normal state.
    const f = insideFamily(series([...healthy(48), ...empty(12, ["signin"])], ["signin"]), "blocked", NOW, 0);
    expect(f.firing).toBe(false);
    expect(f.healthy).toBe(true);
    // relay moved data to "blocked" in only a third of its earlier rounds:
    // not a mover for it, so empty rounds there say nothing.
    const rare = series([...healthy(48), ...empty(8)]).map((c) =>
      c.vantage === "relay" && c.nodeId === "blocked" && c.checkedAt < NOW - 8 * ROUND && Math.round((NOW - c.checkedAt) / ROUND) % 3 !== 0
        ? { ...c, moved: false }
        : c,
    );
    expect(insideFamily(rare, "blocked", NOW, 0).firing).toBe(false);
  });

  it("does not count empty rounds in which the box moved data nowhere: its own line is dead", () => {
    // relay still connects everywhere but moves nothing to any server.
    const dead = (n: number): RoundState[] =>
      Array.from({ length: n }, () => ({ relay: Object.fromEntries(SERVERS.map((s) => [s, "empty" as const])) }));
    const rows = series([...healthy(48), ...dead(12)]);
    for (const server of SERVERS) expect(insideFamily(rows, server, NOW, 0).firing).toBe(false);
    // Dead rounds neither count nor break a streak of real losses.
    const mixed = series([...healthy(48), ...empty(2), ...dead(3), ...empty(2)]);
    expect(insideFamily(mixed, "blocked", NOW, 0).firing).toBe(true);
  });

  it("fires from every box that is reporting, and from the only one reporting, said as such", () => {
    const both = insideFamily(series([...healthy(48), ...lost(INSIDE_LOST_ROUNDS)]), "blocked", NOW, 0);
    expect(both.scope).toMatchObject({ kind: "all", partial: false });
    expect(both.scope!.text).toBe("from every inside box that is reporting (relay and signin)");

    // signin stopped reporting four hours ago: relay alone is reading.
    const rows = series([...healthy(48), ...empty(INSIDE_LOST_ROUNDS)]).filter(
      (c) => c.vantage === "relay" || c.checkedAt < NOW - 4 * HOUR,
    );
    const only = insideFamily(rows, "blocked", NOW, 0);
    expect(only.firing).toBe(true);
    expect(only.scope).toMatchObject({ kind: "only", partial: false, silent: [{ vantage: "signin" }] });
    expect(only.scope!.text).toMatch(/^from relay; only one inside box is reporting; signin has not reported since 2026-10-19T/);
    // And not firing, the silence is still said rather than dropped.
    const quiet = insideFamily(
      series(healthy(52)).filter((c) => c.vantage === "relay" || c.checkedAt < NOW - 4 * HOUR),
      "blocked",
      NOW,
      0,
    );
    expect(quiet.firing).toBe(false);
    expect(quiet.summary).toContain("only one inside box is reporting; signin has not reported since");
  });

  it("does not fire for the fleet when a box's own network partly fails", () => {
    // From some round on, relay reaches only one server and signin nothing.
    // Every server then looks lost from both boxes; none of it is a block.
    const partial = (n: number): RoundState[] =>
      Array.from({ length: n }, () => ({
        relay: Object.fromEntries(SERVERS.filter((s) => s !== "other-a").map((s) => [s, false])),
        signin: Object.fromEntries(SERVERS.map((s) => [s, false])),
      }));
    const rows = series([...healthy(48), ...partial(12)]);
    for (const server of SERVERS.filter((s) => s !== "other-a")) {
      expect(insideFamily(rows, server, NOW, 0).firing).toBe(false);
    }
    // Both boxes reaching only one server each: the same.
    const one = (n: number): RoundState[] =>
      Array.from({ length: n }, () => ({
        relay: Object.fromEntries(SERVERS.filter((s) => s !== "other-a").map((s) => [s, false])),
        signin: Object.fromEntries(SERVERS.filter((s) => s !== "other-b").map((s) => [s, false])),
      }));
    const both = series([...healthy(48), ...one(12)]);
    for (const server of SERVERS) expect(insideFamily(both, server, NOW, 0).firing).toBe(false);
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

  it("keeps a box the open incident recorded as lost once the rounds before its loss have aged out", () => {
    // Only empty rounds are left in the rows read: nothing says relay ever
    // moved data to "blocked", and its bare connects would read as working.
    const rows = series(empty(40));
    const forgot = insideFamily(rows, "blocked", NOW, 0);
    expect(forgot.firing).toBe(false);
    const remembered = insideFamily(rows, "blocked", NOW, 0, undefined, ["relay"]);
    expect(remembered.firing).toBe(true);
    expect(remembered.healthy).toBe(false);
    expect(remembered.scope).toMatchObject({ lost: ["relay"] });
  });

  it("says a box that reports but whose own line carries nothing cannot tell, never that one box is reporting", () => {
    const rounds = [...healthy(48), ...lost(8, ["signin"]).map((r, i) => ({ ...r, ...boxDown(8, "relay")[i] }))];
    const f = insideFamily(series(rounds), "blocked", NOW, 0);
    expect(f.firing).toBe(true);
    expect(f.scope).toMatchObject({ kind: "some", lost: ["signin"], reporting: ["relay", "signin"] });
    expect(f.scope!.text).toBe("from 1 of 2 inside networks (signin); relay reports, but its own line carries nothing, so cannot tell");
  });

  it("calls a box silent after two hours without a row, as the silent-box message does", () => {
    const rows = series([...healthy(48), ...empty(INSIDE_LOST_ROUNDS)]).filter(
      (c) => c.vantage === "relay" || c.checkedAt < NOW - INSIDE_SILENT_AFTER_MS - 10 * MIN,
    );
    expect(insideFamily(rows, "blocked", NOW, 0).scope).toMatchObject({ kind: "only", silent: [{ vantage: "signin" }] });
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

describe("bytesFamily", () => {
  const MB = 1024 * 1024;
  const day = (up: number) => ({ up: up * MB, down: up * 20 * MB });
  const usual = [day(1500), day(1400), day(1600), day(1300), day(1550), day(1450), day(1500)];

  it("reads a collapse of the server's own upload, but never fires without the inside family", () => {
    const totals = { current: day(9), baseline: usual };
    const alone = bytesFamily(totals, false);
    expect(alone).toMatchObject({ family: "bytes", firing: false, thin: false, healthy: false });
    expect(alone.bytes).toMatchObject({ collapsed: true, usualUp: 1500 * MB });
    expect(alone.summary).toContain("counted only beside a recent loss from our inside boxes");
    const beside = bytesFamily(totals, true);
    expect(beside.firing).toBe(true);
    expect(beside.summary).toBe(
      "Server's own bytes: 9.0 MB up and 180 MB down in the last 24 h; usually 1.5 GB up and 29.3 GB down a day -- collapsed",
    );
  });

  it("is too little to judge on a lightly used server or a short history", () => {
    expect(bytesFamily({ current: day(1), baseline: [day(15), day(12), day(18), day(10)] }, true)).toMatchObject({
      firing: false,
      thin: true,
    });
    expect(bytesFamily({ current: day(1), baseline: [day(900), day(800), null, null, null, null, null] }, true)).toMatchObject({
      firing: false,
      thin: true,
    });
  });

  it("is healthy when the upload is back near usual", () => {
    expect(bytesFamily({ current: day(1200), baseline: usual }, false)).toMatchObject({ firing: false, healthy: true });
  });
});

describe("assess with the server's own bytes", () => {
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

  it("never opens anything on bytes alone, even if handed a firing reading", () => {
    const a = assess({
      ...base,
      client: family("client"),
      traffic: family("traffic", { thin: true }),
      probe: family("probe", { healthy: true }),
      inside: family("inside"),
      bytes: family("bytes", { firing: true }),
    });
    expect(a.verdict).toBeNull();
  });

  it("makes an inside loss likely, worded as the traffic collapsing", () => {
    const a = assess({
      ...base,
      client: family("client"),
      traffic: family("traffic", { thin: true }),
      probe: family("probe", { healthy: true, tcpOpen: true }),
      inside: family("inside", { firing: true, lostTcp: false, onset: NOW - 5 * HOUR }),
      bytes: family("bytes", { firing: true }),
    });
    expect(a.verdict).toBe("LIKELY_BLOCKED");
    expect(a.reason).toBe(
      "2 independent signals agree: our own boxes inside the country, and the server's own traffic has collapsed",
    );
    // Data lost, connection open: a tunnel block, not an address one.
    expect(a.blockType).toBe("tunnel");
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

describe("assess keeps a family's start through a reading it could not make", () => {
  it("carries the app reports' since over a restart, so the sustain timer does not start again", () => {
    const quiet = { firing: false, thin: true, healthy: false, onset: null, summary: "", networks: [] };
    const a = assess({
      client: unknownClientFamily("the network table has not loaded yet"),
      traffic: { family: "traffic", ...quiet },
      probe: { family: "probe", ...quiet, firing: true, thin: false, onset: NOW - HOUR },
      outage: null,
      previousSince: { client: NOW - 50 * MIN, probe: NOW - HOUR },
      now: NOW,
    });
    expect(a.since.client).toBe(NOW - 50 * MIN);
    // A family that was read and is quiet loses it, as before.
    const b = assess({
      client: { family: "client", ...quiet, thin: false },
      traffic: { family: "traffic", ...quiet },
      probe: { family: "probe", ...quiet, firing: true, thin: false, onset: NOW - HOUR },
      outage: null,
      previousSince: { client: NOW - 50 * MIN, probe: NOW - HOUR },
      now: NOW,
    });
    expect(b.since.client).toBeUndefined();
  });
});

describe("the server's own bytes beside a loss from one inside box", () => {
  const MB = 1024 * 1024;
  const day = (up: number) => ({ up: up * MB, down: up * 20 * MB });
  const usual = [day(311), day(300), day(330), day(290), day(320), day(310), day(305)];
  const inside = (over: Partial<FamilyResult> = {}): FamilyResult => ({
    family: "inside",
    firing: true,
    thin: false,
    healthy: false,
    onset: NOW - 3 * 24 * HOUR,
    summary: "",
    networks: [],
    lostTcp: false,
    scope: { kind: "partial", partial: true, lost: ["signin"], working: ["ir2"], reporting: ["ir2", "signin"], silent: [], text: "" },
    ...over,
  });

  it("counts only near when the loss began, or while it has counted since, or when every box lost it", () => {
    // netherlands-1: signin lost it three days ago; a quiet afternoon now.
    expect(bytesMayCount(inside(), NOW - 3 * 24 * HOUR, undefined, NOW)).toBe(false);
    expect(bytesMayCount(inside(), NOW - 20 * HOUR, undefined, NOW)).toBe(true);
    expect(bytesMayCount(inside(), NOW - 3 * 24 * HOUR, NOW - 2 * 24 * HOUR, NOW)).toBe(true);
    expect(bytesMayCount(inside({ scope: { ...inside().scope!, kind: "all", partial: false } }), NOW - 3 * 24 * HOUR, undefined, NOW)).toBe(true);
    expect(bytesMayCount(inside({ firing: false }), NOW, undefined, NOW)).toBe(false);
  });

  it("reads a day-old data loss from one box as that network's change while the server's traffic holds up", () => {
    const fine = bytesFamily({ current: day(333), baseline: usual }, false);
    const settled = settleOneNetwork(inside(), fine, NOW - 25 * HOUR, NOW);
    expect(settled).toMatchObject({ firing: false, healthy: true });
    expect(settled.scope).toBeUndefined();
    expect(settled.summary).toContain("read as that one network's change, not a block");
    // Not before a day, not when the bytes collapsed (uk-1), not on a refused
    // connection, not when two boxes lost it, not without bytes to judge.
    expect(settleOneNetwork(inside(), fine, NOW - 20 * HOUR, NOW).firing).toBe(true);
    const collapsed = bytesFamily({ current: day(10), baseline: usual }, false);
    expect(settleOneNetwork(inside(), collapsed, NOW - 25 * HOUR, NOW).firing).toBe(true);
    expect(settleOneNetwork(inside({ lostTcp: true }), fine, NOW - 25 * HOUR, NOW).firing).toBe(true);
    const two = inside({ scope: { ...inside().scope!, kind: "all", lost: ["ir2", "signin"] } });
    expect(settleOneNetwork(two, fine, NOW - 25 * HOUR, NOW).firing).toBe(true);
    const thin = bytesFamily({ current: day(1), baseline: [day(5), day(4), day(6)] }, false);
    expect(settleOneNetwork(inside(), thin, NOW - 25 * HOUR, NOW).firing).toBe(true);
  });
});
