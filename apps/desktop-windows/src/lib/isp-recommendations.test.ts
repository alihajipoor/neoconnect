import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// attempts.ts reaches for Tauri at import time through its store and
// version helpers; none of that is exercised here.
vi.mock("@tauri-apps/plugin-store", () => ({ load: () => Promise.reject(new Error("no store")) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("test") }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: () => Promise.reject(new Error("no network")) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("no tauri")) }));

const { detectPlatform, failedDial, rungsFrom, withNetwork } = await import("./attempts");
const { createSessionTracker, SUSTAINED_MS } = await import("./session-report");
const { currentAttestation, networkHeaders, networkKeyFromAsn, rememberNetwork, resetNetworkForTests } =
  await import("./network-identity");
const { orderCandidates, ispTagsOf } = await import("./failover");
const { recordAttempt } = await import("./connect-history");
const { reachabilityKey } = await import("./reachability");
const { hasRecommended, pickerRows } = await import("./isp-tags");
const { showsAutomatic } = await import("./displayed-route");
const { DICTIONARIES } = await import("./i18n");
const { IspTagLine } = await import("../components/IspTagLine");
import type { IspTag, Protocol, ProtocolUser } from "./types";

beforeEach(() => resetNetworkForTests());

/** The bug the brief named: every iPhone and Mac report was filed as
 * Windows, which would fold three platforms into one row of the per-ISP
 * data. */
describe("detectPlatform", () => {
  it("tells all four platforms apart", () => {
    expect(detectPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8)", 5)).toBe("android");
    expect(detectPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", 5)).toBe("ios");
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe("macos");
    expect(detectPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", 0)).toBe("windows");
  });

  /** iPadOS says it is a Mac; only the touchscreen gives it away. */
  it("files an iPad as iOS, not macOS", () => {
    expect(detectPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe("ios");
  });
});

describe("network identity", () => {
  const body = { ip: "192.0.2.10", asn: 64500, asnOrg: "EXAMPLE-ISP", network: "n1.64500.1.sig" };

  it("keeps the network a baseline reported, and offers it as a header", () => {
    rememberNetwork(body, 1_000);
    expect(currentAttestation(2_000)).toBe("n1.64500.1.sig");
    expect(networkHeaders(2_000)).toEqual({ "X-Neoxify-Network": "n1.64500.1.sig" });
    expect(networkKeyFromAsn(2_000)).toBe("asn:64500");
  });

  /** A baseline the server could not place -- a node mirror answered,
   * say -- must not leave the previous network standing. */
  it("forgets the network when a baseline comes back without one", () => {
    rememberNetwork(body, 1_000);
    rememberNetwork({ ip: "203.0.113.20" }, 2_000);
    expect(currentAttestation(3_000)).toBeNull();
    expect(networkHeaders(3_000)).toEqual({});
  });

  it("stops offering it before the server would refuse it", () => {
    rememberNetwork(body, 0);
    expect(currentAttestation(24 * 3_600_000)).toBeNull();
  });
});

describe("attempt reports", () => {
  const dials = [{ routeId: "r1", carried: false }, null, { routeId: "r2", carried: true }];

  it("puts each dial on its rung, and nothing on a rung without one", () => {
    expect(rungsFrom(["Fast: up but unreachable", "IKEv2: not available", "Stealth: connected"], dials)).toEqual([
      { protocol: "Fast", result: "up but unreachable", routeId: "r1", carried: false },
      { protocol: "IKEv2", result: "not available" },
      { protocol: "Stealth", result: "connected", routeId: "r2", carried: true },
    ]);
  });

  /** A quota or an engine fault is not the network's doing, and must not
   * count against a route for everybody else on that network. */
  it("records a failed dial only for a network failure", () => {
    expect(failedDial("r1", "serverUnreachable")).toEqual({ routeId: "r1", carried: false });
    for (const kind of ["quotaExhausted", "concurrentLimit", "engineMissing", "subscriptionInactive", "unknown"]) {
      expect(failedDial("r1", kind)).toBeNull();
    }
  });

  /** A backend without the feature rejects the new fields with a 400,
   * which the client counts as delivered -- so sending them there would
   * silently lose every connect report. Holding an attestation is the
   * proof the server is new enough. */
  it("sends the new fields only to a server that issued an attestation", () => {
    const report = {
      kind: "CONNECT" as const,
      outcome: "SUCCESS" as const,
      attempts: rungsFrom(["Stealth: connected"], [{ routeId: "r2", carried: true }]),
    };
    expect(withNetwork(report, "n1.64500.1.sig")).toMatchObject({
      network: "n1.64500.1.sig",
      attempts: [{ routeId: "r2", carried: true }],
    });
    const plain = withNetwork(report, null)!;
    expect(plain).not.toHaveProperty("network");
    expect(plain.attempts).toEqual([{ protocol: "Stealth", result: "connected" }]);
    expect(withNetwork({ kind: "SESSION", outcome: "SUCCESS", sessionSeconds: 700 }, null)).toBeNull();
  });
});

describe("session report", () => {
  it("reports once, after ten minutes of continuous health", () => {
    let clock = 0;
    const report = vi.fn().mockResolvedValue(undefined);
    const tracker = createSessionTracker(report, () => clock);
    tracker.healthy("r1", "Stealth");
    clock = SUSTAINED_MS - 1;
    tracker.healthy("r1");
    expect(report).not.toHaveBeenCalled();
    clock = SUSTAINED_MS + 15_000;
    tracker.healthy("r1");
    tracker.healthy("r1");
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({
      kind: "SESSION",
      outcome: "SUCCESS",
      routeId: "r1",
      sessionSeconds: Math.floor((SUSTAINED_MS + 15_000) / 1000),
    });
  });

  /** The claim is continuous health; a session that dropped out half way
   * has not earned it. */
  it("starts over after a failed check or a change of route", () => {
    let clock = 0;
    const report = vi.fn().mockResolvedValue(undefined);
    const tracker = createSessionTracker(report, () => clock);
    tracker.healthy("r1");
    clock = SUSTAINED_MS / 2;
    tracker.broken();
    tracker.healthy("r1");
    clock = SUSTAINED_MS + 1_000;
    tracker.healthy("r2");
    tracker.healthy("r1");
    expect(report).not.toHaveBeenCalled();
  });
});

const user = (routeId: string, protocol: Protocol) => ({ routeId, protocol }) as ProtocolUser;
const LADDER = [user("r-wg", "WIREGUARD"), user("r-reality", "XRAY_VLESS_REALITY"), user("r-tls", "XRAY_VLESS_TLS")];
const ids = (users: ProtocolUser[]) => users.map((u) => u.routeId);
const tag = (code: IspTag["code"]): IspTag => ({ code, customers: 6, outOf: 7, windowHours: 48 });

/** Other people's experience as a tie-break on a network this device
 * knows nothing about -- the first run, which is when people quit. */
describe("orderCandidates with per-ISP tags", () => {
  const tags = { "r-tls": "worksOnYourIsp", "r-wg": "failingOnYourIsp" } as const;

  it("leads with what worked for others when the device has no evidence", () => {
    expect(ids(orderCandidates(LADDER, { ispTags: tags, network: "home" }))).toEqual(["r-tls", "r-reality", "r-wg"]);
  });

  it("is exactly the old order without tags", () => {
    expect(ids(orderCandidates(LADDER, { network: "home" }))).toEqual(["r-wg", "r-reality", "r-tls"]);
  });

  /** ac56993 stands: on a network the device has seen, its own results
   * order the ladder and other people's play no part. */
  it("ignores the tags once the device has any history on this network", () => {
    const history = recordAttempt({}, "home", "r-reality", "XRAY_VLESS_REALITY", true, 0);
    expect(ids(orderCandidates(LADDER, { ispTags: tags, history, network: "home", now: 0 }))).toEqual([
      "r-reality",
      "r-wg",
      "r-tls",
    ]);
  });

  it("ignores them when there is a last-good route here", () => {
    expect(ids(orderCandidates(LADDER, { ispTags: tags, lastGoodRouteId: "r-wg", network: "home" }))[0]).toBe("r-wg");
  });

  it("never overrides the customer's own pin", () => {
    expect(ids(orderCandidates(LADDER, { ispTags: tags, pinnedRouteId: "r-wg" }))[0]).toBe("r-wg");
  });

  /** Live beats reported: something that refused a handshake a second ago
   * will not carry a tunnel however well it did for others. */
  it("ranks below the live probe", () => {
    const reachability = {
      [reachabilityKey("r-tls", "XRAY_VLESS_TLS")]: "unreachable",
      [reachabilityKey("r-reality", "XRAY_VLESS_REALITY")]: "reachable",
    } as const;
    expect(ids(orderCandidates(LADDER, { ispTags: tags, reachability }))).toEqual(["r-reality", "r-wg", "r-tls"]);
  });

  it("reads the tags off the route list", () => {
    expect(ispTagsOf([{ id: "a", ispTag: tag("worksOnYourIsp") }, { id: "b", ispTag: null }, { id: "c" }])).toEqual({
      a: "worksOnYourIsp",
    });
  });
});

describe("picker rows", () => {
  const routes = [{ id: "a", ispTag: null }, { id: "b", ispTag: tag("worksOnYourIsp") }, { id: "c", ispTag: tag("failingOnYourIsp") }];

  it("narrows to what worked, without reordering", () => {
    expect(pickerRows(routes, false).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(pickerRows(routes, true).map((r) => r.id)).toEqual(["b"]);
  });

  /** An empty list would read as "nothing works here", which an absence
   * of evidence does not mean. */
  it("never filters to nothing", () => {
    const none = [{ id: "a", ispTag: null }];
    expect(hasRecommended(none)).toBe(false);
    expect(pickerRows(none, true).map((r) => r.id)).toEqual(["a"]);
  });
});

describe("Automatic on the main screen", () => {
  it("says Automatic until a tunnel has settled, then names where it landed", () => {
    expect(showsAutomatic("disconnected", null)).toBe(true);
    expect(showsAutomatic("connecting", null)).toBe(true);
    expect(showsAutomatic("verifying", null)).toBe(true);
    expect(showsAutomatic("connected", null)).toBe(false);
  });

  it("always names a pinned server", () => {
    expect(showsAutomatic("disconnected", "r1")).toBe(false);
  });
});

describe("IspTagLine", () => {
  const translate = (lang: "en" | "fa") => (key: keyof (typeof DICTIONARIES)["en"], vars?: Record<string, string | number>) => {
    let text: string = DICTIONARIES[lang][key];
    for (const [k, v] of Object.entries(vars ?? {})) text = text.split(`{${k}}`).join(String(v));
    return text;
  };
  const render = (t: ReturnType<typeof translate>, ispTag: IspTag | null) =>
    renderToStaticMarkup(createElement(IspTagLine, { tag: ispTag, t }));

  it("renders nothing without a tag", () => {
    expect(render(translate("en"), null)).toBe("");
  });

  /** Hedged and dated, never a promise, with the evidence attached. */
  it("words a works tag as what others saw recently, with the counts", () => {
    const html = render(translate("en"), tag("worksOnYourIsp"));
    expect(html).toContain("Worked for most people on your network recently");
    expect(html).toContain("6 of 7 people, last 48 hours");
    expect(html).toContain('data-isp-tag="worksOnYourIsp"');
  });

  it("renders Persian", () => {
    const html = render(translate("fa"), tag("failingOnYourIsp"));
    expect(html).toContain(DICTIONARIES.fa["loc.ispFailing"]);
    expect(html).toContain("6 نفر از 7 نفر");
  });
});
