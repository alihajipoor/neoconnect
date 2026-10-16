import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayAnswer } from "./last-resort";

/** The relay of last resort's policy (docs/relay-last-resort.md, R1):
 * when a call may go to the box in Iran, and what that does to the
 * device's state. The transport is faked; the Rust command's own checks
 * are relay_http.rs's tests. */

let entries: { url: string; pins: string[] }[] = [];
vi.mock("./endpoint-bundle-store", () => ({ lastResortEntries: () => Promise.resolve(entries) }));

let carrier: string | null = "asn:58224";
const stamps: Record<string, string> = {};
vi.mock("./network-identity", () => ({
  networkKeyFromAsn: () => carrier,
  stampedCountry: (key: string | null) => (key === null ? null : (stamps[key] ?? null)),
  // The one stamped last: in this fake, the last one added.
  latestStampedCountry: () => Object.values(stamps).slice(-1)[0] ?? null,
}));

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const lr = await import("./last-resort");
const { ladderPass } = await import("./ladder-pass");

const PIN = `sha256/${btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))}`;
const BOX_A = { url: "https://192.0.2.10/api", pins: [PIN] };
const BOX_B = { url: "https://198.51.100.20/api", pins: [PIN] };
const BOX_C = { url: "https://203.0.113.30/api", pins: [PIN] };

type Sent = { base: string; method: string; path: string; timeoutMs: number; headers: Record<string, string> };
let sent: Sent[] = [];
let replies: (((args: Sent) => Promise<RelayAnswer>) | RelayAnswer | string)[] = [];
let now = 1_000_000;
let tunnelUp: boolean | null = false;

const json = (status: number, body: unknown): RelayAnswer => ({
  status,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify(body),
});

function reset(options: { tehran?: boolean } = {}) {
  store.clear();
  entries = [BOX_A, BOX_B, BOX_C];
  carrier = "asn:58224";
  for (const key of Object.keys(stamps)) delete stamps[key];
  stamps["asn:58224"] = "IR";
  sent = [];
  replies = [];
  now = 1_000_000;
  tunnelUp = false;
  ladderPass.running.current = false;
  lr.resetLastResortForTests({
    now: () => now,
    environment: { timeZone: options.tehran ? "Asia/Tehran" : "Europe/Berlin", languages: ["en-US"] },
    tunnelUp: () => Promise.resolve(tunnelUp),
    transport: async (args) => {
      sent.push(args as Sent);
      const reply = replies.shift();
      if (reply === undefined) throw "relay: connect-timeout";
      if (typeof reply === "string") throw reply;
      if (typeof reply === "function") return reply(args as Sent);
      return reply;
    },
  });
  lr.setRelayConsent(true);
}

beforeEach(() => reset());

const ME = { method: "GET" as const, path: "/customer/me" };
const LOGIN = { method: "POST" as const, path: "/customer-auth/login", body: "{}" };

describe("what the relay carries", () => {
  it("sends nothing that is not on its list", async () => {
    replies = [json(200, {})];
    for (const call of [
      { method: "POST" as const, path: "/customer/subscriptions" },
      { method: "POST" as const, path: "/customer/billing/payments" },
      { method: "GET" as const, path: "/customer/gaming-profile" },
      { method: "POST" as const, path: "/client-attempts" },
    ]) {
      expect(await lr.relayRequest(call, "foreground")).toEqual({ kind: "skipped", reason: "path" });
    }
    expect(sent).toEqual([]);
  });

  it("says nothing was dialled when the command is not in this build", async () => {
    replies = ["command relay_request not found"];
    expect(await lr.relayRequest(ME, "foreground")).toEqual({ kind: "skipped", reason: "none" });
  });

  it("sends nothing when the bundle names no relay", async () => {
    entries = [];
    expect(await lr.relayRequest(ME, "foreground")).toEqual({ kind: "skipped", reason: "none" });
    expect(sent).toEqual([]);
  });
});

describe("consent (R1.4)", () => {
  it("is asked once, before any byte is sent, and a decline is remembered", async () => {
    lr.resetLastResortForTests({ now: () => now, tunnelUp: () => Promise.resolve(false), transport: async () => json(200, {}) });
    let asked = 0;
    lr.onRelayConsentAsked(async () => {
      asked += 1;
      return false;
    });
    expect(await lr.relayRequest(ME, "foreground")).toEqual({ kind: "skipped", reason: "declined" });
    expect(await lr.relayRequest(ME, "foreground")).toEqual({ kind: "skipped", reason: "declined" });
    expect(asked).toBe(1);
    expect(lr.relayConsent()).toBe("declined");
  });

  it("is never asked by a background request, and nothing is sent without it", async () => {
    store.delete("neoxify.relay.consent");
    let asked = 0;
    lr.onRelayConsentAsked(async () => {
      asked += 1;
      return true;
    });
    replies = [json(200, {})];
    expect(await lr.relayRequest(ME, "background")).toEqual({ kind: "skipped", reason: "unasked" });
    expect(asked).toBe(0);
    expect(sent).toEqual([]);
  });

  it("is not assumed when there is no screen to ask on", async () => {
    store.delete("neoxify.relay.consent");
    expect(await lr.relayRequest(ME, "foreground")).toEqual({ kind: "skipped", reason: "unasked" });
    expect(sent).toEqual([]);
  });

  it("asks one question for requests that need it at once", async () => {
    store.delete("neoxify.relay.consent");
    let answer: (granted: boolean) => void = () => undefined;
    let asked = 0;
    lr.onRelayConsentAsked(
      () =>
        new Promise<boolean>((resolve) => {
          asked += 1;
          answer = resolve;
        }),
    );
    replies = [json(200, {}), json(200, {})];
    const both = Promise.all([lr.relayRequest(ME, "foreground"), lr.relayRequest(ME, "foreground")]);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([]);
    answer(true);
    const outcomes = await both;
    expect(asked).toBe(1);
    expect(outcomes.map((o) => o.kind)).toEqual(["answered", "answered"]);
  });

  it("is not asked while a tunnel holds the gate", async () => {
    store.delete("neoxify.relay.consent");
    let asked = 0;
    lr.onRelayConsentAsked(async () => {
      asked += 1;
      return true;
    });
    tunnelUp = true;
    expect(await lr.relayRequest(ME, "foreground")).toEqual({ kind: "gated" });
    expect(asked).toBe(0);
    expect(lr.relayConsent()).toBeNull();
  });

  it("can be withdrawn in Settings, which ends relay mode", async () => {
    replies = [json(200, {})];
    await lr.relayRequest(ME, "foreground");
    expect(lr.relayModeActive()).toBe(true);
    lr.setRelayConsent(false);
    expect(lr.relayModeActive()).toBe(false);
    expect(await lr.relayRequest(ME, "foreground")).toEqual({ kind: "skipped", reason: "declined" });
  });
});

describe("the tunnel gate (R1.5)", () => {
  it("holds in every state but a tunnel reported down", async () => {
    for (const state of [true, null] as const) {
      reset();
      tunnelUp = state;
      replies = [json(200, {})];
      expect(await lr.relayRequest(ME, "foreground")).toEqual({ kind: "gated" });
      expect(sent).toEqual([]);
    }
  });

  it("holds while a connect is under way, even with the tunnel down", async () => {
    ladderPass.running.current = true;
    ladderPass.startedAt.current = Date.now();
    replies = [json(200, {})];
    expect(await lr.relayRequest(ME, "foreground")).toEqual({ kind: "gated" });
    ladderPass.running.current = false;
    expect(sent).toEqual([]);
  });

  it("holds when the tunnel cannot be asked, or does not say", async () => {
    lr.setRelayTunnelReader(() => Promise.reject(new Error("service gone")));
    replies = [json(200, {})];
    expect(await lr.relayRequest(ME, "foreground")).toEqual({ kind: "gated" });
    expect(sent).toEqual([]);
  });

  it("is not there at all in a build with no tunnel to read -- the web portal", async () => {
    lr.resetLastResortForTests({ now: () => now, transport: async () => json(200, {}) });
    lr.setRelayConsent(true);
    expect(lr.relaySupported()).toBe(false);
    expect(await lr.relayRequest(ME, "foreground")).toEqual({ kind: "skipped", reason: "none" });
    expect(await lr.relaySignupOffered()).toBe(false);
  });

  it("is checked when the call's turn comes, not when it was asked for", async () => {
    let release: () => void = () => undefined;
    replies = [() => new Promise((resolve) => (release = () => resolve(json(200, {})))), json(200, {})];
    const first = lr.relayRequest(ME, "foreground");
    const second = lr.relayRequest(ME, "foreground");
    await new Promise((r) => setTimeout(r, 0));
    // A connect starts while the first is out.
    tunnelUp = true;
    release();
    expect((await first).kind).toBe("answered");
    expect(await second).toEqual({ kind: "gated" });
    expect(sent).toHaveLength(1);
  });
});

describe("Iran evidence (R1.3)", () => {
  it("is the server's stamp for this network when there is one", async () => {
    stamps["asn:58224"] = "DE";
    reset({ tehran: true });
    stamps["asn:58224"] = "DE";
    expect(lr.iranEvidence()).toBe(false);
    expect(await lr.relayRequest(ME, "foreground")).toEqual({ kind: "skipped", reason: "not-iran" });
  });

  it("is the latest stamp of any network when this one cannot be named", async () => {
    // A day without a baseline -- every hour of a blackout -- leaves no
    // network key. Where the server last placed the device stands over
    // its settings: a Persian-language phone abroad is abroad.
    reset({ tehran: true });
    carrier = null;
    delete stamps["asn:58224"];
    stamps["asn:3320"] = "DE";
    expect(lr.iranEvidence()).toBe(false);
    expect(await lr.relayRequest(ME, "foreground")).toEqual({ kind: "skipped", reason: "not-iran" });
    expect(sent).toEqual([]);
    stamps["asn:58224"] = "IR";
    expect(lr.iranEvidence()).toBe(true);
  });

  it("is the latest stamp of any network on a network the server answered without placing", () => {
    reset({ tehran: true });
    carrier = "asn:44244";
    delete stamps["asn:58224"];
    stamps["asn:3320"] = "DE";
    expect(lr.iranEvidence()).toBe(false);
  });

  it("is the time zone or the region only on an install never stamped anywhere", () => {
    delete stamps["asn:58224"];
    carrier = null;
    lr.resetLastResortForTests({ environment: { timeZone: "Asia/Tehran", languages: ["en-US"] } });
    expect(lr.iranEvidence()).toBe(true);
    carrier = "asn:58224";
    lr.resetLastResortForTests({ environment: { timeZone: "Asia/Tehran", languages: ["en-US"] } });
    expect(lr.iranEvidence()).toBe(true);
    lr.resetLastResortForTests({ environment: { timeZone: "Europe/London", languages: ["fa-IR"] } });
    expect(lr.iranEvidence()).toBe(true);
    lr.resetLastResortForTests({ environment: { timeZone: "Europe/London", languages: ["fa", "en-GB"] } });
    expect(lr.iranEvidence()).toBe(false);
  });
});

describe("boxes and time (R1.6)", () => {
  it("asks at most two boxes, within twelve seconds all told", async () => {
    replies = [
      async (args: Sent) => {
        now += 5_000;
        throw args.timeoutMs === 12_000 ? "relay: connect-timeout" : "unexpected";
      },
      async (args: Sent) => {
        expect(args.timeoutMs).toBe(7_000);
        throw "relay: connect-timeout";
      },
    ];
    expect(await lr.relayRequest(ME, "foreground")).toEqual({ kind: "unanswered" });
    expect(sent.map((s) => s.base)).toEqual([BOX_A.url, BOX_B.url]);
  });

  it("does not send a write to a second box once the first may have taken it", async () => {
    replies = ["relay: timeout", json(200, {})];
    expect(await lr.relayRequest(LOGIN, "foreground")).toEqual({ kind: "unanswered" });
    expect(sent).toHaveLength(1);
  });

  it("sends a write on when the first box never took it", async () => {
    replies = ["relay: pin-mismatch", json(200, { accessToken: "a" })];
    expect((await lr.relayRequest(LOGIN, "foreground")).kind).toBe("answered");
    expect(sent.map((s) => s.base)).toEqual([BOX_A.url, BOX_B.url]);
  });

  it("asks the box that answered last first", async () => {
    replies = ["relay: connect-timeout", json(200, {}), json(200, {})];
    await lr.relayRequest(ME, "foreground");
    await lr.relayRequest(ME, "foreground");
    expect(sent.map((s) => s.base)).toEqual([BOX_A.url, BOX_B.url, BOX_B.url]);
  });

  it("sends one call at a time", async () => {
    let inFlight = 0;
    let most = 0;
    const slow = async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return json(200, {});
    };
    replies = [slow, slow, slow];
    await Promise.all([lr.relayRequest(ME, "foreground"), lr.relayRequest(ME, "foreground"), lr.relayRequest(ME, "foreground")]);
    expect(sent).toHaveLength(3);
    expect(most).toBe(1);
  });

  it("stops at forty an hour and two hundred a day, counting only connected attempts", async () => {
    for (let i = 0; i < 10; i += 1) {
      replies = ["relay: connect-timeout", "relay: connect-timeout"];
      await lr.relayRequest(ME, "foreground");
    }
    for (let i = 0; i < 40; i += 1) {
      replies = [json(200, {})];
      expect((await lr.relayRequest(ME, "foreground")).kind).toBe("answered");
    }
    replies = [json(200, {})];
    expect(await lr.relayRequest(ME, "foreground")).toEqual({ kind: "skipped", reason: "budget" });
    // Five more hours of forty fills the day.
    for (let hour = 1; hour <= 4; hour += 1) {
      now += 3_600_000;
      for (let i = 0; i < 40; i += 1) {
        replies = [json(200, {})];
        await lr.relayRequest(ME, "foreground");
      }
    }
    now += 3_600_000;
    replies = [json(200, {})];
    expect(await lr.relayRequest(ME, "foreground")).toEqual({ kind: "skipped", reason: "budget" });
    now += 24 * 3_600_000;
    replies = [json(200, {})];
    expect((await lr.relayRequest(ME, "foreground")).kind).toBe("answered");
  });
});

describe("relay mode (R1.7)", () => {
  it("starts on the backend's JSON through the relay, not on a page", async () => {
    replies = [{ status: 404, contentType: "text/html", body: "<html>" }];
    expect((await lr.relayRequest(ME, "foreground")).kind).toBe("answered");
    expect(lr.relayModeActive()).toBe(false);
    replies = [json(401, { message: "Unauthorized" })];
    await lr.relayRequest(ME, "foreground");
    expect(lr.relayModeActive()).toBe(true);
  });

  it("lasts fifteen minutes from the last answer, on this network only", async () => {
    replies = [json(200, {})];
    await lr.relayRequest(ME, "foreground");
    now += 14 * 60_000;
    replies = [json(200, {})];
    await lr.relayRequest(ME, "foreground");
    now += 14 * 60_000;
    expect(lr.relayModeActive()).toBe(true);
    carrier = "asn:44244";
    expect(lr.relayModeActive()).toBe(false);
    carrier = "asn:58224";
    now += 60_001;
    expect(lr.relayModeActive()).toBe(false);
  });

  it("asks the ordinary routes again at most every three minutes", async () => {
    replies = [json(200, {})];
    await lr.relayRequest(ME, "foreground");
    expect(lr.skipNormalRoutes()).toBe(true);
    now += 3 * 60_000;
    expect(lr.skipNormalRoutes()).toBe(false);
    expect(lr.skipNormalRoutes()).toBe(true);
  });

  it("ends on an answer from an ordinary route", async () => {
    replies = [json(200, {})];
    await lr.relayRequest(ME, "foreground");
    lr.noteNormalRouteAnswered();
    expect(lr.relayModeActive()).toBe(false);
    expect(lr.skipNormalRoutes()).toBe(false);
  });

  it("ends after two relay calls in a row get no answer", async () => {
    replies = [json(200, {})];
    await lr.relayRequest(ME, "foreground");
    replies = ["relay: network", "relay: network"];
    await lr.relayRequest(ME, "foreground");
    expect(lr.relayModeActive()).toBe(true);
    replies = ["relay: network", "relay: network"];
    await lr.relayRequest(ME, "foreground");
    expect(lr.relayModeActive()).toBe(false);
  });

  it("ends when it is ended -- a tunnel connect -- and tells who is listening", async () => {
    let told = 0;
    lr.onRelayChange(() => {
      told += 1;
    });
    replies = [json(200, {})];
    await lr.relayRequest(ME, "foreground");
    lr.endRelayMode();
    expect(lr.relayModeActive()).toBe(false);
    expect(told).toBe(2);
  });

  it("ends when a tunnel comes up, whichever app brought it up", async () => {
    replies = [json(200, {})];
    await lr.relayRequest(ME, "foreground");
    expect(lr.relayModeActive()).toBe(true);
    ladderPass.running.current = true;
    ladderPass.startedAt.current = Date.now();
    expect(lr.relayModeActive()).toBe(false);
    ladderPass.running.current = false;
    tunnelUp = true;
    expect(await lr.relayRequest(ME, "background")).toEqual({ kind: "gated" });
    tunnelUp = false;
    expect(lr.relayModeActive()).toBe(false);
  });

  it("ends when a connect pass ends with a tunnel up -- the phone's, which tells nothing else", async () => {
    replies = [json(200, {})];
    await lr.relayRequest(ME, "foreground");
    let told = 0;
    lr.onRelayChange(() => {
      told += 1;
    });
    ladderPass.running.current = true;
    ladderPass.startedAt.current = Date.now();
    tunnelUp = true;
    ladderPass.running.current = false;
    ladderPass.ended();
    await vi.waitFor(() => expect(lr.relayModeActive()).toBe(false));
    expect(told).toBe(1);
  });

  it("goes on after a connect pass that left no tunnel up", async () => {
    replies = [json(200, {})];
    await lr.relayRequest(ME, "foreground");
    ladderPass.ended();
    await lr.checkTunnelForRelayMode();
    expect(lr.relayModeActive()).toBe(true);
  });

  it("ends when a tunnel is found up that no pass in this app brought up", async () => {
    // A phone's quick-settings tile or always-on VPN, or a tunnel the
    // service kept up across a restart of the app.
    replies = [json(200, {})];
    await lr.relayRequest(ME, "foreground");
    tunnelUp = null;
    await lr.checkTunnelForRelayMode();
    expect(lr.relayModeActive()).toBe(true);
    tunnelUp = true;
    await lr.checkTunnelForRelayMode();
    expect(lr.relayModeActive()).toBe(false);
  });

  it("is turned off for a day on this network by a RELAY_REGION refusal", async () => {
    replies = [json(200, {}), json(403, { code: "RELAY_REGION", message: "..." })];
    await lr.relayRequest(ME, "foreground");
    expect((await lr.relayRequest(LOGIN, "foreground")).kind).toBe("answered");
    expect(lr.relayModeActive()).toBe(false);
    replies = [json(200, {})];
    expect(await lr.relayRequest(ME, "foreground")).toEqual({ kind: "skipped", reason: "off" });
    expect(await lr.relaySignupOffered()).toBe(false);
    // Another network is not affected.
    carrier = "asn:44244";
    stamps["asn:44244"] = "IR";
    expect((await lr.relayRequest(ME, "foreground")).kind).toBe("answered");
    carrier = "asn:58224";
    now += 24 * 3_600_000 + 1;
    replies = [json(200, {})];
    expect((await lr.relayRequest(ME, "foreground")).kind).toBe("answered");
  });

  it("does not dial a call queued behind the RELAY_REGION refusal", async () => {
    replies = [json(200, {})];
    await lr.relayRequest(ME, "foreground");
    sent.length = 0;
    replies = [json(403, { code: "RELAY_REGION", message: "..." }), json(200, {})];
    const [first, second] = await Promise.all([
      lr.relayRequest(LOGIN, "foreground"),
      lr.relayRequest(ME, "foreground"),
    ]);
    expect(first.kind).toBe("answered");
    expect(second).toEqual({ kind: "skipped", reason: "off" });
    expect(sent).toHaveLength(1);
  });

  it("is not started again by a relay answer to a call made before an ordinary route answered", async () => {
    replies = [json(200, {})];
    await lr.relayRequest(ME, "foreground");
    let answer!: (reply: RelayAnswer) => void;
    replies = [() => new Promise<RelayAnswer>((resolve) => (answer = resolve))];
    const out = lr.relayRequest(ME, "foreground");
    await vi.waitFor(() => expect(answer).toBeDefined());
    lr.noteNormalRouteAnswered();
    expect(lr.relayModeActive()).toBe(false);
    answer(json(200, {}));
    expect((await out).kind).toBe("answered");
    expect(lr.relayModeActive()).toBe(false);
    // A call made after it starts relay mode as before.
    replies = [json(200, {})];
    await lr.relayRequest(ME, "foreground");
    expect(lr.relayModeActive()).toBe(true);
  });

  it("does not dial a call queued when the backup route is switched off, nor start relay mode", async () => {
    let answer!: (reply: RelayAnswer) => void;
    replies = [() => new Promise<RelayAnswer>((resolve) => (answer = resolve)), json(200, {})];
    const first = lr.relayRequest(ME, "foreground");
    const second = lr.relayRequest(LOGIN, "foreground");
    await vi.waitFor(() => expect(answer).toBeDefined());
    lr.setRelayConsent(false);
    answer(json(200, {}));
    expect((await first).kind).toBe("answered");
    expect(await second).toEqual({ kind: "skipped", reason: "declined" });
    expect(sent).toHaveLength(1);
    expect(lr.relayModeActive()).toBe(false);
  });

  it("stays on after a sign-up the backend refused because it could not place the network", async () => {
    // An ASN missing from its table, or the table not loaded: sign-up
    // needs Iran, sign-in, refresh and vouchers do not -- so the refusal
    // is the sign-up's alone, and switches nothing off.
    const REGISTER = { method: "POST" as const, path: "/customer-auth/relay-register", body: "{}" };
    replies = [json(200, {}), json(403, { code: "RELAY_REGION_UNKNOWN", message: "..." })];
    await lr.relayRequest(ME, "foreground");
    expect((await lr.relayRequest(REGISTER, "foreground")).kind).toBe("answered");
    expect(lr.relayModeActive()).toBe(true);
    replies = [json(200, {})];
    expect((await lr.relayRequest(LOGIN, "foreground")).kind).toBe("answered");
  });
});

describe("relay status", () => {
  it("is read from the backend through the relay, never assumed", async () => {
    expect(lr.relayStatus()).toBeNull();
    replies = [json(200, { signup: true, intranet: false })];
    expect(await lr.refreshRelayStatus()).toEqual({ signup: true, intranet: false });
    expect(sent[0].path).toBe("/relay/status");
    lr.endRelayMode();
    expect(lr.relayStatus()).toBeNull();
  });
});

describe("relay sign-up on offer", () => {
  it("needs a relay, Iran evidence and no decline, and sends nothing to find out", async () => {
    expect(await lr.relaySignupOffered()).toBe(true);
    lr.setRelayConsent(false);
    expect(await lr.relaySignupOffered()).toBe(false);
    lr.setRelayConsent(true);
    entries = [];
    expect(await lr.relaySignupOffered()).toBe(false);
    entries = [BOX_A];
    stamps["asn:58224"] = "TR";
    expect(await lr.relaySignupOffered()).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("the install id", () => {
  it("is stable for the install and shaped as the backend accepts it", () => {
    const id = lr.relayInstallId();
    expect(id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(lr.relayInstallId()).toBe(id);
    expect(lr.relayInstallHeaders()).toEqual({ "X-Neoxify-Install-Id": id });
  });
});
