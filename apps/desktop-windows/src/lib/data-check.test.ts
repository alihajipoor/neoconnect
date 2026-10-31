import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const {
  checkDataMoves,
  DOWN_BYTES,
  judgeDataCheck,
  keepsSlow,
  noSlowRungs,
  noteSlow,
  passOverSlow,
  presentsOwnName,
  serverKey,
  slowFallback,
  UP_BYTES,
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
