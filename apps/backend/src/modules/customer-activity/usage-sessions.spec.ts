import { buildSessions, SESSION_GAP_MS, type UsagePeriod } from "./usage-sessions";

const T0 = Date.UTC(2026, 10, 1, 10, 0, 0);
const MIN = 60_000;
const p = (startMin: number, endMin: number, up = 10n, down = 100n, nodeName = "alpha", protocol = "SHADOWSOCKS"): UsagePeriod => ({
  nodeName,
  protocol,
  start: T0 + startMin * MIN,
  end: T0 + endMin * MIN,
  bytesUp: up,
  bytesDown: down,
});

describe("buildSessions", () => {
  it("joins periods up to 15 minutes apart and splits past that", () => {
    const sessions = buildSessions([p(0, 1), p(1, 2), p(17, 18), p(34, 35)]);
    // 2 -> 17 is exactly 15 minutes: joined. 18 -> 34 is 16: split.
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ start: new Date(T0 + 34 * MIN).toISOString(), seconds: 60, bytesUp: "10" });
    expect(sessions[1]).toMatchObject({
      start: new Date(T0).toISOString(),
      end: new Date(T0 + 18 * MIN).toISOString(),
      seconds: 18 * 60,
      bytesUp: "30",
      bytesDown: "300",
    });
    expect(SESSION_GAP_MS).toBe(15 * MIN);
  });

  it("ignores download-only periods, so a dead peer's handshakes make no session and bridge no gap", () => {
    const sessions = buildSessions([p(0, 1), p(10, 11, 0n, 5000n), p(20, 21, 0n), p(30, 31)]);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.bytesDown === "100")).toBe(true);
    expect(buildSessions([p(0, 1, 0n), p(1, 2, 0n)])).toEqual([]);
  });

  it("keeps servers and protocols apart, newest first, and caps the count", () => {
    const sessions = buildSessions([p(0, 1, 1n, 1n, "alpha"), p(1, 2, 1n, 1n, "beta"), p(2, 3, 1n, 1n, "alpha", "WIREGUARD")]);
    expect(sessions.map((s) => `${s.nodeName}/${s.protocol}`)).toEqual(["alpha/WIREGUARD", "beta/SHADOWSOCKS", "alpha/SHADOWSOCKS"]);
    expect(buildSessions([p(0, 1), p(100, 101), p(200, 201)], SESSION_GAP_MS, 2)).toHaveLength(2);
  });
});
