import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const {
  checkDataMoves,
  describeSearchEnd,
  describeSlow,
  DOWN_BYTES,
  endSearch,
  judgeDataCheck,
  judgeSample,
  keepsSlow,
  LEG_MS,
  noSlowRungs,
  noteDial,
  noteSlow,
  passedUploadKbps,
  passOverSlow,
  presentsOwnName,
  rememberedKbps,
  rememberedKbpsWith,
  restartSearch,
  rungSpeeds,
  SAMPLE_MS,
  sampleDownload,
  searching,
  searchOrder,
  serverKey,
  SLOW_SEARCH_MAX_DIALS,
  SLOW_SEARCH_MAX_MS,
  slowFallback,
  UP_BYTES,
  UP_LEG_MAX_MS,
  UP_LEG_SHARE,
  uploadLegMs,
} = await import("./data-check");
import type { DataCheck } from "./data-check";
import type { ProtocolUser } from "./types";

const leg = (status: number | null, bytes: number, ms: number) => ({ status, bytes, ms });

/** A usable tunnel: 128 KB down in 0.4 s, 256 KB up in 1.2 s. */
const GOOD: DataCheck = { down: leg(200, DOWN_BYTES, 400), up: leg(200, UP_BYTES, 1_200), peer: null };

describe("judgeDataCheck", () => {
  it("passes a tunnel that moved both ways in time, with its speeds", () => {
    expect(judgeDataCheck(GOOD)).toEqual({ state: "moves", downKbps: 2621, upKbps: 1748 });
  });

  /** Measured from inside Iran in October 2026: the first 63-95 KB of an
   * upload go through at once, then about 0.1 Mbps. 256 KB does not
   * finish in eight seconds, so the upload comes back with no answer. */
  it("calls a held upload slow, whatever the download did", () => {
    const held = { ...GOOD, up: leg(null, 0, 8_000) };
    expect(judgeDataCheck(held)).toEqual({ state: "slow", downKbps: 2621, upKbps: 0 });
  });

  it("calls a download that stopped short slow", () => {
    const short = { ...GOOD, down: leg(200, 40_000, 8_000) };
    expect(judgeDataCheck(short).state).toBe("slow");
  });

  it("calls a tunnel that answered nothing at all slow", () => {
    expect(judgeDataCheck({ down: leg(null, 0, 8_000), up: leg(null, 0, 0), peer: null }).state).toBe("slow");
  });

  /** Our side, not the tunnel: a busy API (503), a backend from before the
   * endpoint (404), a mirror's error page. Never held against a server. */
  it.each([503, 404, 502])("leaves a %i from our endpoint unmeasured", (status) => {
    expect(judgeDataCheck({ ...GOOD, down: leg(status, 0, 50) }).state).toBe("unmeasured");
    expect(judgeDataCheck({ ...GOOD, up: leg(status, 0, 50) }).state).toBe("unmeasured");
  });

  it("leaves no check at all unmeasured", () => {
    expect(judgeDataCheck(null)).toEqual({ state: "unmeasured" });
  });
});

describe("checkDataMoves", () => {
  it("asks the endpoint that answered the address check, for both sizes", async () => {
    invoke.mockResolvedValueOnce(GOOD);
    await expect(checkDataMoves("https://api.example/api")).resolves.toMatchObject({ state: "moves" });
    expect(invoke).toHaveBeenLastCalledWith("data_check_v4", {
      base: "https://api.example/api",
      downBytes: DOWN_BYTES,
      upBytes: UP_BYTES,
      timeoutMs: 8_000,
    });
  });

  /** An older build, or an IPC failure: nothing is known, so the rung is
   * judged as it was before this check existed. */
  it("is unmeasured when the command fails or there is no endpoint", async () => {
    invoke.mockRejectedValueOnce(new Error("unknown command"));
    await expect(checkDataMoves("https://api.example/api")).resolves.toEqual({ state: "unmeasured" });
    await expect(checkDataMoves(undefined)).resolves.toEqual({ state: "unmeasured" });
  });
});

/** The speed a landed tunnel actually gives: a second and a half of
 * download, counted. */
describe("sampleDownload", () => {
  /** 1.2 MB in 1.5 s is 6.4 Mbps; the upload leg is not made. */
  const SAMPLED: DataCheck = { down: leg(200, 1_200_000, 1_500), up: leg(null, 0, 0), peer: null };

  it("asks the check's endpoint for a timed stream, and reads the rate", async () => {
    invoke.mockResolvedValueOnce(SAMPLED);
    await expect(sampleDownload("https://api.example/api")).resolves.toEqual({ downKbps: 6400, bytes: 1_200_000, ms: 1_500 });
    expect(invoke).toHaveBeenLastCalledWith("data_check_v4", {
      base: "https://api.example/api",
      downBytes: 512 * 1024,
      upBytes: 1,
      timeoutMs: SAMPLE_MS + 4_000,
      sampleMs: SAMPLE_MS,
    });
  });

  /** An API from before the window serves the 512 KB asked and stops; the
   * whole of it over its time is still a reading. */
  it("reads a fixed body from an older API as a shorter sample", () => {
    expect(judgeSample({ ...SAMPLED, down: leg(200, 524_288, 400) })).toEqual({ downKbps: 10486, bytes: 524_288, ms: 400 });
  });

  /** Busy, an error page, no answer: nothing is known, and nothing is
   * recorded or reported -- never a zero. */
  it("is nothing when our endpoint did not answer with data", async () => {
    for (const down of [leg(503, 0, 20), leg(404, 0, 20), leg(null, 0, 5_500), leg(200, 0, 1_500), leg(200, 4096, 0)]) {
      expect(judgeSample({ ...SAMPLED, down })).toBeNull();
    }
    invoke.mockRejectedValueOnce(new Error("unknown command"));
    await expect(sampleDownload("https://api.example/api")).resolves.toBeNull();
    await expect(sampleDownload(undefined)).resolves.toBeNull();
  });
});

/** What the landed rung's report says it moved. */
describe("rungSpeeds", () => {
  const moves = judgeDataCheck(GOOD);
  const sample = { downKbps: 6400, bytes: 1_200_000, ms: 1_500 };

  it("prefers the sample's download to the check's, and keeps the check's upload", () => {
    expect(rungSpeeds(moves, sample)).toEqual({ downKbps: 6400, upKbps: 1748 });
    expect(rungSpeeds(moves, null)).toEqual({ downKbps: 2621, upKbps: 1748 });
  });

  /** A leg that ran out of time has no speed, only "too slow": the slow
   * fallback that landed reports what was measured and nothing for the
   * rest. And nothing at all where nothing was. */
  it("says nothing for a leg that was not measured", () => {
    const held = judgeDataCheck({ ...GOOD, up: leg(null, 0, 8_000) });
    expect(rungSpeeds(held, sample)).toEqual({ downKbps: 6400 });
    expect(rungSpeeds(held, null)).toEqual({ downKbps: 2621 });
    expect(rungSpeeds({ state: "unmeasured" }, null)).toEqual({});
    expect(rungSpeeds(null, sample)).toEqual({ downKbps: 6400 });
  });

  it("stays within the server's bounds", () => {
    expect(rungSpeeds(null, { ...sample, downKbps: 1e9 })).toEqual({ downKbps: 10_000_000 });
    expect(rungSpeeds(null, { ...sample, downKbps: 1234.6 })).toEqual({ downKbps: 1235 });
  });
});

/** What the landed rung is remembered by once the sample is in: the
 * slower direction still, with the sample's download in place of the
 * check's -- never the download alone, which would have remembered an
 * upload-held server as fast and led with it next time. */
describe("rememberedKbpsWith", () => {
  const sample = { downKbps: 6400, bytes: 1_200_000, ms: 1_500 };

  it("keeps the check's upload when it is the slower direction", () => {
    const moves = judgeDataCheck(GOOD);
    expect(rememberedKbps(moves)).toBe(1748);
    expect(rememberedKbpsWith(moves, sample)).toBe(1748);
    expect(rememberedKbpsWith(moves, { ...sample, downKbps: 900 })).toBe(900);
  });

  it("leaves a held upload at nothing, however fast the download sampled", () => {
    const held = judgeDataCheck({ ...GOOD, up: leg(null, 0, 8_000) });
    expect(rememberedKbps(held)).toBe(0);
    expect(rememberedKbpsWith(held, sample)).toBe(0);
  });

  it("touches nothing when the check measured nothing, or there is no sample", () => {
    expect(rememberedKbpsWith({ state: "unmeasured" }, sample)).toBeNull();
    expect(rememberedKbpsWith(null, sample)).toBeNull();
    expect(rememberedKbpsWith(judgeDataCheck(GOOD), null)).toBeNull();
  });
});

describe("slow rungs", () => {
  // A route is one server and one protocol: "germany-1 / VLESS+TLS".
  const user = (id: string, host: string, protocol = "XRAY_VLESS_REALITY", security?: string): ProtocolUser =>
    ({ id, routeId: `${id}-route`, protocol, connection: { host, security } }) as unknown as ProtocolUser;
  const routes = [] as Array<{ id: string; exit: string | null }>;
  const uk = user("uk-reality", "198.51.100.1");
  const ukTls = user("uk-tls", "198.51.100.1", "XRAY_VLESS_TLS");
  const tr = user("tr-reality", "198.51.100.2");
  const de = user("de-reality", "198.51.100.3");

  it("passes over the rest of a slow server, keeps the faster of two, and puts it back once", () => {
    const slow = noSlowRungs((u) => serverKey(u, routes));
    noteSlow(slow, uk, { state: "slow", downKbps: 3000, upKbps: 0 });
    expect(passOverSlow(slow, ukTls)).toBe(true);
    expect(passOverSlow(slow, de)).toBe(false);

    noteSlow(slow, tr, { state: "slow", downKbps: 900, upKbps: 120 });
    // Upload first: it is the direction that is held.
    expect(slowFallback(slow)).toBe(tr);
    expect(keepsSlow(slow, tr)).toBe(true);
    expect(passOverSlow(slow, tr)).toBe(false);
    expect(keepsSlow(slow, uk)).toBe(false);
    // Once.
    expect(slowFallback(slow)).toBeNull();
  });

  /** One entry box, two exits: the held one is passed over, not the other. */
  it("tells a relay's exits apart", () => {
    const relayRoutes = [
      { id: "to-tr", exit: "exit-tr" },
      { id: "to-de", exit: "exit-de" },
    ];
    const viaTr = { id: "a", routeId: "to-tr", connection: { host: "192.0.2.9" } } as unknown as ProtocolUser;
    const viaDe = { id: "b", routeId: "to-de", connection: { host: "192.0.2.9" } } as unknown as ProtocolUser;
    const slow = noSlowRungs((u) => serverKey(u, relayRoutes));
    noteSlow(slow, viaTr, { state: "slow", downKbps: 100, upKbps: 0 });
    expect(passOverSlow(slow, viaDe)).toBe(false);
  });

  it("has nothing to put back when nothing was slow", () => {
    expect(slowFallback(noSlowRungs())).toBeNull();
  });

  /** Which rungs show the network one of our own names: the TLS ones
   * with our certificate behind them. REALITY borrows a name, and the
   * rest present none. Stealth (legacy) only when carried over TLS. */
  it("knows which protocols present our own server name", () => {
    expect(presentsOwnName(user("a", "h", "XRAY_VLESS_TLS"))).toBe(true);
    expect(presentsOwnName(user("b", "h", "XRAY_TROJAN"))).toBe(true);
    expect(presentsOwnName(user("c", "h", "XRAY_VMESS", "TLS"))).toBe(true);
    expect(presentsOwnName(user("d", "h", "XRAY_VMESS", "NONE"))).toBe(false);
    for (const protocol of ["XRAY_VLESS_REALITY", "SHADOWSOCKS", "WIREGUARD", "OPENVPN", "IKEV2"]) {
      expect(presentsOwnName(user("e", "h", protocol))).toBe(false);
    }
  });

  /** Iran throttles by name as well as by address. A Stealth HTTPS rung
   * held that way said nothing about Stealth or Shadowsocks on the same
   * box -- the rungs built to get past exactly that -- and the ladder was
   * skipping them on its strength. So its evidence reaches only the other
   * rungs there that show our name. */
  it("lets a slow own-name rung pass over only the other own-name rungs on its server", () => {
    const ukWeb = user("uk-web", "198.51.100.1", "XRAY_VLESS_TLS");
    const ukLite = user("uk-lite", "198.51.100.1", "XRAY_TROJAN");
    const ukSs = user("uk-ss", "198.51.100.1", "SHADOWSOCKS");
    const slow = noSlowRungs((u) => serverKey(u, routes));
    noteSlow(slow, ukTls, { state: "slow", downKbps: 900, upKbps: 0 });
    expect(passOverSlow(slow, ukWeb)).toBe(true);
    expect(passOverSlow(slow, ukLite)).toBe(true);
    expect(passOverSlow(slow, uk)).toBe(false);
    expect(passOverSlow(slow, ukSs)).toBe(false);
    expect(passOverSlow(slow, de)).toBe(false);
    // Still the best slow rung to fall back on, and never passed over itself.
    expect(slowFallback(slow)).toBe(ukTls);
    expect(passOverSlow(slow, ukTls)).toBe(false);
  });

  /** A hold on the address slows every protocol there alike, measured
   * twice: a slow REALITY or Shadowsocks rung is evidence against all of
   * them, the own-name ones included. */
  it("lets a slow address-level rung pass over everything on its server", () => {
    const ukSs = user("uk-ss", "198.51.100.1", "SHADOWSOCKS");
    const slow = noSlowRungs((u) => serverKey(u, routes));
    noteSlow(slow, ukSs, { state: "slow", downKbps: 900, upKbps: 0 });
    expect(passOverSlow(slow, uk)).toBe(true);
    expect(passOverSlow(slow, ukTls)).toBe(true);
    expect(passOverSlow(slow, de)).toBe(false);
  });
});

/** A slow rung is one that works. The ladder used to walk on from it to
 * its very end before going back to it, and on a network where most
 * servers carry nothing a customer cancelled long before that end. */
describe("the search for something better than a slow rung", () => {
  const user = (id: string, host: string, protocol = "XRAY_VLESS_REALITY"): ProtocolUser =>
    ({ id, routeId: `${id}-route`, protocol, connection: { host } }) as unknown as ProtocolUser;
  const START = 1_800_000_000_000;
  const SLOW = { state: "slow", downKbps: 2400, upKbps: 0 } as const;
  const de = user("de", "198.51.100.3");
  const others = ["a", "b", "c", "d"].map((id, i) => user(id, `198.51.100.${10 + i}`));
  /** A pass on a network whose memory has seen `moved` carry traffic
   * lately -- the customer's usual server, by default. */
  const pass = (moved: ProtocolUser[] = [de]) => noSlowRungs((u) => serverKey(u, []), moved);
  const begun = () => {
    const slow = pass();
    noteSlow(slow, de, SLOW, START);
    return slow;
  };

  it("is three further rungs dialled, or forty seconds", () => {
    expect(SLOW_SEARCH_MAX_DIALS).toBe(3);
    expect(SLOW_SEARCH_MAX_MS).toBe(40_000);
  });

  it("has no budget to run out while nothing has been slow", () => {
    const slow = noSlowRungs();
    for (const other of others) noteDial(slow, other);
    expect(endSearch(slow, START + 10 * SLOW_SEARCH_MAX_MS)).toBeNull();
    expect(slow.search).toBeNull();
  });

  it("goes back to the slow rung after three further rungs were dialled, and keeps it", () => {
    const slow = begun();
    noteDial(slow, others[0]);
    noteDial(slow, others[1]);
    expect(endSearch(slow, START + 12_000)).toBeNull();
    noteDial(slow, others[2]);
    expect(endSearch(slow, START + 20_000)).toEqual({ candidate: de, dials: 3, ms: 20_000 });
    // Kept whatever its check says this time, and never passed over itself.
    expect(keepsSlow(slow, de)).toBe(true);
    expect(passOverSlow(slow, de)).toBe(false);
    // Once: the pass goes on from it if it does not come up.
    expect(endSearch(slow, START + 60_000)).toBeNull();
  });

  it("goes back after forty seconds, however few were dialled", () => {
    const slow = begun();
    noteDial(slow, others[0]);
    expect(endSearch(slow, START + SLOW_SEARCH_MAX_MS - 1)).toBeNull();
    expect(endSearch(slow, START + SLOW_SEARCH_MAX_MS)).toEqual({ candidate: de, dials: 1, ms: 40_000 });
  });

  it("counts rungs dialled, not rungs passed over, and a rung dialled twice once", () => {
    const slow = begun();
    // The slow server's other protocols are passed over: nothing is dialled.
    expect(passOverSlow(slow, user("de-ss", "198.51.100.3", "SHADOWSOCKS"))).toBe(true);
    noteDial(slow, others[0]);
    noteDial(slow, others[0]);
    noteDial(slow, others[1]);
    expect(endSearch(slow, START + 5_000)).toBeNull();
  });

  /** The regression this guards: a held server reads slow exactly as a
   * slow line does -- download done, upload out of time. Stopping early
   * for it kept the customer on about 0.1 Mbps up while a clean server
   * sat a few rungs further down, never dialled. */
  it("is not begun by a slow rung on a server this network has not seen move: the pass walks on, as it did", () => {
    const [held, alsoHeld, dead, deadToo] = others;
    // No memory of this network at all.
    const slow = noSlowRungs((u) => serverKey(u, []));
    noteSlow(slow, held, { state: "slow", downKbps: 3000, upKbps: 0 }, START);
    noteDial(slow, alsoHeld);
    noteSlow(slow, alsoHeld, { state: "slow", downKbps: 2000, upKbps: 0 }, START + 10_000);
    noteDial(slow, dead);
    noteDial(slow, deadToo);
    expect(slow.search).toBeNull();
    // Nor is what is left of the ladder put in another order for it.
    expect(searching(slow)).toBe(false);
    expect(endSearch(slow, START + 10 * SLOW_SEARCH_MAX_MS)).toBeNull();
    // Its other protocols are still passed over, and at the very end of
    // the ladder it is still the fallback: both as before.
    expect(passOverSlow(slow, user("held-ss", "198.51.100.10", "SHADOWSOCKS"))).toBe(true);
    expect(slowFallback(slow)).toBe(held);

    // The same with a memory that knows another server: a pinned
    // country's held server is not what moved here.
    const pinned = pass([de]);
    noteSlow(pinned, held, { state: "slow", downKbps: 3000, upKbps: 0 }, START);
    for (const other of [alsoHeld, dead, deadToo]) noteDial(pinned, other);
    expect(endSearch(pinned, START + 10 * SLOW_SEARCH_MAX_MS)).toBeNull();
  });

  it("is begun by the first slow rung on a server seen moving, and goes back to that one -- not to a faster-reading one never seen moving", () => {
    const [held, a, b, c] = others;
    const slow = pass([de]);
    // A held server first: nothing begins.
    noteSlow(slow, held, { state: "slow", downKbps: 5000, upKbps: 0 }, START);
    noteDial(slow, de);
    expect(endSearch(slow, START + 50_000)).toBeNull();
    // The usual server, slow this time: the clock starts here.
    noteSlow(slow, de, SLOW, START + 50_000);
    expect(slow.search?.since).toBe(START + 50_000);
    expect(searching(slow)).toBe(true);
    for (const other of [a, b, c]) noteDial(slow, other);
    // The held one read the faster download; it is not what is kept.
    expect(endSearch(slow, START + 60_000)?.candidate).toBe(de);
    expect(searching(slow)).toBe(false);
    expect(keepsSlow(slow, de)).toBe(true);
    expect(keepsSlow(slow, held)).toBe(false);
  });

  it("knows a server by any of its rungs: the one that moved here need not be the one that is slow now", () => {
    const slow = pass([user("de-ss", "198.51.100.3", "SHADOWSOCKS")]);
    noteSlow(slow, de, SLOW, START);
    expect(endSearch(slow, START + SLOW_SEARCH_MAX_MS)?.candidate).toBe(de);
  });

  it("is one search for the pass: a second slow rung neither restarts the clock nor the count, and the better of the two is kept", () => {
    const slow = pass([de, others[0]]);
    noteSlow(slow, de, SLOW, START);
    noteDial(slow, others[0]);
    noteSlow(slow, others[0], { state: "slow", downKbps: 900, upKbps: 140 }, START + 15_000);
    noteDial(slow, others[1]);
    noteDial(slow, others[2]);
    expect(endSearch(slow, START + 30_000)?.candidate).toBe(others[0]);
  });

  /** "Slow" is also what the check calls a tunnel it got nothing through
   * at all. That one is not known to work, so the pass does not stop
   * looking for its sake. */
  it("is not begun by a rung that moved nothing either way, which is still the fallback at the end", () => {
    const nothing = pass();
    noteSlow(nothing, de, { state: "slow", downKbps: 0, upKbps: 0 }, START);
    for (const other of others) noteDial(nothing, other);
    expect(endSearch(nothing, START + 10 * SLOW_SEARCH_MAX_MS)).toBeNull();
    expect(slowFallback(nothing)).toBe(de);

    // One that moves data, later in the pass, begins the search then --
    // and is what the pass goes back to.
    const later = pass([de, others[0]]);
    noteSlow(later, de, { state: "slow", downKbps: 0, upKbps: 0 }, START);
    noteSlow(later, others[0], SLOW, START + 100_000);
    expect(endSearch(later, START + 100_000 + SLOW_SEARCH_MAX_MS - 1)).toBeNull();
    expect(endSearch(later, START + 100_000 + SLOW_SEARCH_MAX_MS)?.candidate).toBe(others[0]);
  });

  it("starts its budget afresh after a wait for a network", () => {
    const slow = begun();
    noteDial(slow, others[0]);
    noteDial(slow, others[1]);
    restartSearch(slow, START + 600_000);
    expect(endSearch(slow, START + 600_000 + 1_000)).toBeNull();
    noteDial(slow, others[0]);
    noteDial(slow, others[1]);
    noteDial(slow, others[2]);
    expect(endSearch(slow, START + 600_000 + 2_000)?.dials).toBe(3);
  });

  it("puts the slow rung back once more at the end of the ladder, if it did not land when put back early", () => {
    const slow = begun();
    expect(endSearch(slow, START + SLOW_SEARCH_MAX_MS)?.candidate).toBe(de);
    // It did not come up; the pass walked the rest; nothing landed.
    expect(slowFallback(slow)).toBe(de);
    expect(keepsSlow(slow, de)).toBe(true);
    expect(slowFallback(slow)).toBeNull();
  });

  it("leaves the end of the ladder as it was when the budget was never used up", () => {
    const slow = begun();
    noteDial(slow, others[0]);
    expect(slowFallback(slow)).toBe(de);
    expect(slowFallback(slow)).toBeNull();
    // Put back at the end: there is no search left to end.
    expect(endSearch(slow, START + 10 * SLOW_SEARCH_MAX_MS)).toBeNull();
  });

  it("says what it did, and how many rungs it did not dial", () => {
    expect(describeSearchEnd({ candidate: de, dials: 2, ms: 41_300 }, 38)).toBe(
      "going back to it -- slow, but it works; 2 more dialled in 41 s found nothing better, 38 further not dialled yet",
    );
  });

  it("searches first what this network has seen move, each group in the order it had", () => {
    const [a, b, c, d] = others;
    const moved = new Set([c.id]);
    expect(searchOrder([a, b, c, d], (u) => moved.has(u.id))).toEqual([c, a, b, d]);
    // Nothing remembered: the order it had.
    expect(searchOrder([a, b, c, d], () => false)).toEqual([a, b, c, d]);
    // The location the customer chose keeps its lead over both.
    expect(
      searchOrder(
        [a, b, c, d],
        (u) => moved.has(u.id),
        (u) => u.id === "b",
      ),
    ).toEqual([b, c, a, d]);
  });
});

/** A line that is merely slow must not read as a server that is held: the
 * upload leg is given time by what this network's own working uploads
 * have managed (`typicalUploadKbps` in connect-history.ts). */
describe("the upload leg's time", () => {
  it("is the usual eight seconds on a network nothing is remembered of", () => {
    expect(LEG_MS).toBe(8_000);
    expect(uploadLegMs(null)).toBe(8_000);
    expect(uploadLegMs(undefined)).toBe(8_000);
    // And for a figure that is no speed at all.
    for (const none of [0, -5, Number.NaN]) expect(uploadLegMs(none)).toBe(8_000);
  });

  /** 256 KB at 60% of 300 kbps: 2,097,152 bits at 180 kbps. */
  it("is about eleven and a half seconds where uploads typically pass at 300 kbps", () => {
    expect(UP_LEG_SHARE).toBe(0.6);
    expect(uploadLegMs(300)).toBe(11_651);
    expect(uploadLegMs(300)).toBeLessThan(UP_LEG_MAX_MS);
  });

  it("stops at the cap however slow the line", () => {
    expect(UP_LEG_MAX_MS).toBe(12_000);
    expect(uploadLegMs(150)).toBe(12_000);
    expect(uploadLegMs(1)).toBe(12_000);
  });

  it("is the usual eight seconds wherever uploads are fast", () => {
    expect(uploadLegMs(2_000)).toBe(8_000);
    expect(uploadLegMs(50_000)).toBe(8_000);
    expect(uploadLegMs(Number.POSITIVE_INFINITY)).toBe(8_000);
    // The line between: 60% of 437 kbps is the 262 kbps eight seconds ask.
    expect(uploadLegMs(437)).toBe(8_000);
    expect(uploadLegMs(430)).toBeGreaterThan(8_000);
  });

  it("is never under the usual leg nor over the cap, and never shorter for a slower line", () => {
    let last = Number.POSITIVE_INFINITY;
    for (let kbps = 50; kbps <= 5_000; kbps += 25) {
      const ms = uploadLegMs(kbps);
      expect(ms).toBeGreaterThanOrEqual(LEG_MS);
      expect(ms).toBeLessThanOrEqual(UP_LEG_MAX_MS);
      expect(ms).toBeLessThanOrEqual(last);
      last = ms;
    }
  });

  /** The hold as measured: a first 63-95 KB at once, then about 0.1 Mbps.
   * The cap has to stay under the quickest of those -- and does by little
   * more than a second, which is the whole margin. */
  it("stays under the held upload's signature, by about a tenth", () => {
    const heldMs = (freeKb: number, kbps: number) => ((UP_BYTES - freeKb * 1024) * 8) / kbps;
    expect(heldMs(95, 100)).toBeGreaterThan(13_000);
    expect(heldMs(63, 100)).toBeGreaterThan(15_000);
    expect(UP_LEG_MAX_MS).toBeLessThan(heldMs(95, 100));
    // How thin: a hold one tenth less strict, with the largest free
    // burst, finishes just inside the cap.
    expect(heldMs(95, 110)).toBeLessThan(UP_LEG_MAX_MS);
    expect(heldMs(95, 109)).toBeGreaterThan(UP_LEG_MAX_MS);
  });
});

describe("the data check on a network with a slow line", () => {
  const BASE = "https://api.example/api";
  type Asked = { timeoutMs: number; upTimeoutMs?: number };

  /** The Rust side's upload leg, for an upload that needs `needsMs`: done
   * with its time if that is inside the leg, and otherwise no answer and
   * no bytes at the leg's end (`data_check_v4`). */
  const uploadTaking = (needsMs: number) => (_command: string, asked: Asked) => {
    const legMs = asked.upTimeoutMs ?? asked.timeoutMs;
    const up = needsMs <= legMs ? leg(200, UP_BYTES, needsMs) : leg(null, 0, legMs);
    return Promise.resolve({ down: leg(200, DOWN_BYTES, 900), up, peer: null });
  };

  afterEach(() => {
    invoke.mockReset();
    vi.useRealTimers();
  });

  it("passes an upload that took ten seconds where uploads typically pass at 300 kbps, with its real speed", async () => {
    invoke.mockImplementation(uploadTaking(10_000));
    const verdict = await checkDataMoves(BASE, uploadLegMs(300));
    expect(verdict).toEqual({ state: "moves", downKbps: 1165, upKbps: 210, upLegMs: 11_651 });
    // The download's leg is the one it always had; only the upload's is longer.
    expect(invoke).toHaveBeenLastCalledWith("data_check_v4", {
      base: BASE,
      downBytes: DOWN_BYTES,
      upBytes: UP_BYTES,
      timeoutMs: 8_000,
      upTimeoutMs: 11_651,
    });
    // What the report says it moved, and what the line is remembered by.
    expect(rungSpeeds(verdict, null)).toEqual({ downKbps: 1165, upKbps: 210 });
    expect(passedUploadKbps(verdict)).toBe(210);
  });

  it("fails the same upload where uploads are fast, asked exactly as it always was", async () => {
    invoke.mockImplementation(uploadTaking(10_000));
    const verdict = await checkDataMoves(BASE, uploadLegMs(2_000));
    expect(verdict).toEqual({ state: "slow", downKbps: 1165, upKbps: 0 });
    expect(invoke).toHaveBeenLastCalledWith("data_check_v4", {
      base: BASE,
      downBytes: DOWN_BYTES,
      upBytes: UP_BYTES,
      timeoutMs: 8_000,
    });
    expect(passedUploadKbps(verdict)).toBeNull();
  });

  it("fails it on a network nothing is remembered of", async () => {
    invoke.mockImplementation(uploadTaking(10_000));
    await expect(checkDataMoves(BASE, uploadLegMs(null))).resolves.toEqual({ state: "slow", downKbps: 1165, upKbps: 0 });
    await expect(checkDataMoves(BASE)).resolves.toEqual({ state: "slow", downKbps: 1165, upKbps: 0 });
  });

  /** The held server's thirteen seconds: over the cap, so over every leg. */
  it.each([null, 150, 300, 2_000])("fails an upload that took thirteen seconds, whatever the line (%s kbps)", async (typical) => {
    invoke.mockImplementation(uploadTaking(13_000));
    const verdict = await checkDataMoves(BASE, uploadLegMs(typical));
    expect(verdict.state).toBe("slow");
    expect(verdict).toMatchObject({ upKbps: 0 });
  });

  it("holds whatever leg it is passed between the usual one and the cap", async () => {
    invoke.mockImplementation(uploadTaking(1_000));
    await checkDataMoves(BASE, 60_000);
    expect(invoke.mock.calls[0][1]).toMatchObject({ timeoutMs: 8_000, upTimeoutMs: 12_000 });
    await checkDataMoves(BASE, 100);
    expect(invoke.mock.calls[1][1]).not.toHaveProperty("upTimeoutMs");
    await checkDataMoves(BASE, Number.NaN);
    expect(invoke.mock.calls[2][1]).not.toHaveProperty("upTimeoutMs");
  });

  /** The guard against an IPC reply that never comes used to be two usual
   * legs and two seconds. A download that used its eight seconds and an
   * upload that used most of twelve answers after that -- and a check the
   * guard ends reads `unmeasured`, which lands the rung unchecked. */
  it("waits out both legs before giving a check up as unmeasured", async () => {
    vi.useFakeTimers();
    invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ down: leg(200, DOWN_BYTES, 7_900), up: leg(200, UP_BYTES, 11_900), peer: null }), 19_800);
        }),
    );
    const answered = checkDataMoves(BASE, 12_000);
    await vi.advanceTimersByTimeAsync(19_800);
    await expect(answered).resolves.toMatchObject({ state: "moves", upKbps: 176, upLegMs: 12_000 });

    // And no longer than that: a reply that never comes is given up on
    // two seconds after both legs must have ended.
    invoke.mockImplementation(() => new Promise(() => undefined));
    let verdict: unknown = "waiting";
    void checkDataMoves(BASE, 12_000).then((v) => {
      verdict = v;
    });
    await vi.advanceTimersByTimeAsync(8_000 + 12_000 + 1_999);
    expect(verdict).toBe("waiting");
    await vi.advanceTimersByTimeAsync(1);
    expect(verdict).toEqual({ state: "unmeasured" });

    // The usual check's guard is the one it had.
    verdict = "waiting";
    void checkDataMoves(BASE).then((v) => {
      verdict = v;
    });
    await vi.advanceTimersByTimeAsync(2 * 8_000 + 1_999);
    expect(verdict).toBe("waiting");
    await vi.advanceTimersByTimeAsync(1);
    expect(verdict).toEqual({ state: "unmeasured" });
  });

  it("says how long the upload was given in a slow rung's line, only where that was longer", () => {
    expect(describeSlow({ state: "slow", downKbps: 1165, upKbps: 0 })).toBe("too slow (1165 kbps down, 0 kbps up)");
    expect(describeSlow({ state: "slow", downKbps: 1165, upKbps: 0, upLegMs: 11_651 })).toBe(
      "too slow (1165 kbps down, 0 kbps up, upload given 11.7 s)",
    );
  });

  it("remembers a line by the uploads of checks that passed, and no others", () => {
    expect(passedUploadKbps({ state: "moves", downKbps: 2621, upKbps: 1748 })).toBe(1748);
    expect(passedUploadKbps({ state: "slow", downKbps: 2621, upKbps: 140 })).toBeNull();
    expect(passedUploadKbps({ state: "unmeasured" })).toBeNull();
    expect(passedUploadKbps(null)).toBeNull();
  });
});

/** The search's forty seconds are time spent looking, not the difference
 * between two readings of the time of day, which a device changes under
 * a running pass when it sets its clock. */
describe("the search's clock", () => {
  const user = (id: string, host: string): ProtocolUser =>
    ({ id, routeId: `${id}-route`, protocol: "XRAY_VLESS_REALITY", connection: { host } }) as unknown as ProtocolUser;
  const de = user("de", "198.51.100.3");
  const SLOW = { state: "slow", downKbps: 2400, upKbps: 0 } as const;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not end a search because the time of day jumped forward", () => {
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(5_000);
    const wall = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const slow = noSlowRungs((u) => serverKey(u, []), [de]);
    noteSlow(slow, de, SLOW);
    expect(slow.search?.since).toBe(5_000);
    // The clock is set an hour on; ten seconds have passed.
    wall.mockReturnValue(1_800_000_000_000 + 3_600_000);
    monotonic.mockReturnValue(15_000);
    expect(endSearch(slow)).toBeNull();
    // Forty seconds of looking ends it, and that is what it reports.
    monotonic.mockReturnValue(5_000 + SLOW_SEARCH_MAX_MS);
    expect(endSearch(slow)).toEqual({ candidate: de, dials: 0, ms: 40_000 });
  });

  it("still ends it after forty seconds when the time of day jumped back", () => {
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const wall = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const slow = noSlowRungs((u) => serverKey(u, []), [de]);
    noteSlow(slow, de, SLOW);
    wall.mockReturnValue(1_800_000_000_000 - 3_600_000);
    monotonic.mockReturnValue(1_000 + SLOW_SEARCH_MAX_MS);
    expect(endSearch(slow)?.ms).toBe(40_000);
  });

  it("starts the budget afresh on the same clock after a wait for a network", () => {
    const monotonic = vi.spyOn(performance, "now").mockReturnValue(1_000);
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const slow = noSlowRungs((u) => serverKey(u, []), [de]);
    noteSlow(slow, de, SLOW);
    monotonic.mockReturnValue(301_000);
    restartSearch(slow);
    expect(slow.search?.since).toBe(301_000);
    monotonic.mockReturnValue(301_000 + SLOW_SEARCH_MAX_MS - 1);
    expect(endSearch(slow)).toBeNull();
  });
});
