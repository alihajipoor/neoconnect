import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The phone's half of the plan's device limit, through the shared slot
 * session and the real claim/renew/release calls, with only `apiRequest`
 * stood in for.
 *
 * What the shared session decides is tested where it lives, in the
 * Windows client's tree. What is tested here is what the phone adds: the
 * claim asked alongside the config refresh and inside its three seconds,
 * renewal only in the foreground, the check as the app comes back to the
 * front, a teardown that says "down" only on the platform's word, and the
 * name the claim gives the phone. None of it has run on a phone or
 * against the real backend. */

type Answer =
  | { ok: true; data: unknown }
  | { ok: false; error: string; status?: number; code?: string; body?: unknown; sessionExpired?: boolean }
  | "hang";

const calls: { path: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
let answer: (path: string) => Answer = () => "hang";

vi.mock("@shared/lib/api", () => ({
  apiRequest: (path: string, init?: RequestInit) => {
    calls.push({
      path,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : {},
      headers: { ...(init?.headers as Record<string, string> | undefined) },
    });
    const reply = answer(path);
    if (reply === "hang") {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    return Promise.resolve(reply);
  },
  // Reached by the attempt reporter's imports; nothing here reports.
  publicRequest: () => Promise.resolve({ ok: false, error: "not used in these tests" }),
}));

const { createDeviceSlotSession, createSlotTeardown, slotStop, slotTeardownShown } = await import(
  "@shared/lib/device-slot-session"
);
const { slotNoticeShown } = await import("@shared/lib/device-slot-notice");
const { claimWhileRefreshing, renewInForeground, slotTeardownAttempt, tearDownForSlot, whenForegrounded } =
  await import("./device-slot-steps");

const SUB = "6f1c2b9e-0000-4000-8000-000000000001";
const CRED = "a2b4c6d8-0000-4000-8000-000000000002";

const GRANT = {
  granted: true,
  enforced: true,
  subscriptionId: SUB,
  limit: 1,
  handle: "Zm9vYmFyYmF6",
  renewEverySec: 60,
  staleAfterSec: 90,
};

const HELD = { status: "held", ...GRANT };

const REFUSAL = {
  statusCode: 409,
  code: "DEVICE_LIMIT",
  message: "Your plan allows 1 device at a time.",
  limit: 1,
  holders: [
    {
      handle: "YmF6cXV4",
      label: "Windows PC",
      platform: "windows",
      since: "2026-10-06T10:32:04.120Z",
      lastSeen: "2026-10-06T10:55:41.004Z",
    },
  ],
};

/** A session on a clock the test moves. */
function session() {
  let t = 1_000_000;
  const slot = createDeviceSlotSession({ now: () => t });
  return { slot, advance: (ms: number) => (t += ms) };
}

const fresh = () => Promise.resolve("fresh config");

beforeEach(() => {
  calls.length = 0;
  answer = () => "hang";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("before dialling", () => {
  it("does not dial on a refusal, says where, and reports a limit with no rungs", async () => {
    answer = () => ({ ok: false, error: REFUSAL.message, status: 409, code: "DEVICE_LIMIT", body: REFUSAL });
    const { slot } = session();

    const { refreshed, stop } = await claimWhileRefreshing(
      { subscriptionId: SUB, protocolUserId: CRED, deviceLimit: 1 },
      fresh,
      slot,
    );

    // The refresh is not wasted on a refusal: what it brought is kept.
    expect(refreshed).toBe("fresh config");
    expect(stop?.notice).toEqual({
      kind: "refused",
      refusal: {
        limit: 1,
        holders: [
          {
            handle: "YmF6cXV4",
            label: "Windows PC",
            platform: "windows",
            since: "2026-10-06T10:32:04.120Z",
            lastSeen: "2026-10-06T10:55:41.004Z",
          },
        ],
      },
    });
    // REJECTED with no ladder: no failed dial, no route marked as failing.
    expect(stop?.report).toEqual({ kind: "CONNECT", outcome: "REJECTED", reason: "DEVICE_LIMIT" });
    expect(stop?.report).not.toHaveProperty("attempts");
    expect(stop?.inactive).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/customer/vpn/claim");
    expect(calls[0].body).toEqual({ subscriptionId: SUB, protocolUserId: CRED });
  });

  it("dials on a grant", async () => {
    answer = () => ({ ok: true, data: GRANT });
    const { slot } = session();

    const { stop } = await claimWhileRefreshing({ subscriptionId: SUB, protocolUserId: CRED }, fresh, slot);

    expect(stop).toBeNull();
    expect(slot.standing()).toBe("held");
  });

  it("asks the claim and the refresh at the same time, not one after the other", async () => {
    answer = () => ({ ok: true, data: GRANT });
    const { slot } = session();
    let finishRefresh: (value: string) => void = () => undefined;
    const refresh = vi.fn(() => new Promise<string>((resolve) => (finishRefresh = resolve)));

    const pending = claimWhileRefreshing({ subscriptionId: SUB, protocolUserId: CRED }, refresh, slot);

    // The claim is on its way while the refresh has not answered.
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(refresh).toHaveBeenCalledTimes(1);
    finishRefresh("fresh config");
    expect((await pending).stop).toBeNull();
  });

  it("dials anyway when the API does not answer within three seconds", async () => {
    vi.useFakeTimers();
    answer = () => "hang";
    const { slot } = session();
    let settled = false;

    const pending = claimWhileRefreshing({ subscriptionId: SUB, protocolUserId: CRED }, fresh, slot).then((r) => {
      settled = true;
      return r;
    });

    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect((await pending).stop).toBeNull();
    // Asked again through the tunnel once it is up.
    expect(slot.standing()).toBe("unclaimed");
  });

  it("dials anyway on a network failure or a 5xx", async () => {
    for (const reply of [
      { ok: false as const, error: "Could not reach Neoxify. Check your internet connection." },
      { ok: false as const, error: "Bad gateway", status: 502 },
    ]) {
      answer = () => reply;
      const { slot } = session();
      const { stop } = await claimWhileRefreshing({ subscriptionId: SUB, protocolUserId: CRED }, fresh, slot);
      expect(stop).toBeNull();
    }
  });

  /** Dial, claim once more through the tunnel (obligation 2: the API may
   * be reached another way there), and then renew at the interval
   * (obligation 11: anything but a verdict keeps the tunnel and renews)
   * -- never more often, and never at the tunnel's expense. */
  it("dials against a backend without slots, claims once through the tunnel, then renews at the interval", async () => {
    answer = (path) => ({ ok: false, error: `Cannot POST ${path}`, status: 404 });
    const { slot, advance } = session();

    const { stop } = await claimWhileRefreshing({ subscriptionId: SUB, protocolUserId: CRED }, fresh, slot);
    expect(stop).toBeNull();

    await slot.afterConnected({ protocolUserId: CRED });
    expect(calls).toHaveLength(2);
    advance(10 * 60_000);
    expect(await renewInForeground(slot, () => true)).toEqual({ kind: "keep" });
    expect(await renewInForeground(slot, () => true)).toEqual({ kind: "keep" });
    expect(calls.map((c) => c.path)).toEqual(["/customer/vpn/claim", "/customer/vpn/claim", "/customer/vpn/renew"]);
    advance(60_000);
    expect(await renewInForeground(slot, () => true)).toEqual({ kind: "keep" });
    expect(calls).toHaveLength(4);
    expect(calls[3].path).toBe("/customer/vpn/renew");
  });

  it.each([
    ["a 409 with no code", { ok: false as const, error: "Conflict", status: 409 }],
    ["a 429 from the request limit", { ok: false as const, error: "Too Many Requests", status: 429 }],
    ["a 502", { ok: false as const, error: "Bad Gateway", status: 502 }],
  ])("dials on %s -- only the three coded answers stop a dial", async (_name, reply) => {
    answer = () => reply;
    const { slot } = session();
    const { stop } = await claimWhileRefreshing({ subscriptionId: SUB, protocolUserId: CRED }, fresh, slot);
    expect(stop).toBeNull();
  });

  it("does not ask at all on a plan the subscription says is unlimited", async () => {
    const { slot } = session();

    const { stop } = await claimWhileRefreshing(
      { subscriptionId: SUB, protocolUserId: CRED, deviceLimit: null },
      fresh,
      slot,
    );

    expect(stop).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("sends the handles shown on 'Use on this device instead'", async () => {
    answer = () => ({ ok: true, data: GRANT });
    const { slot } = session();

    const { stop } = await claimWhileRefreshing(
      { subscriptionId: SUB, protocolUserId: CRED, takeover: ["YmF6cXV4"] },
      fresh,
      slot,
    );

    expect(stop).toBeNull();
    expect(calls[0].body).toEqual({ subscriptionId: SUB, protocolUserId: CRED, takeover: ["YmF6cXV4"] });
  });

  /** A filtered network where the API answers only through the tunnel:
   * the takeover cannot arrive before dialling, so the claim through the
   * tunnel carries it. Without it the server refused again in favour of
   * the PC, and every press of the button ended the same way. */
  it("sends the takeover through the tunnel when it could not be sent before dialling", async () => {
    vi.useFakeTimers();
    answer = () => "hang";
    const { slot } = session();
    const pending = claimWhileRefreshing(
      { subscriptionId: SUB, protocolUserId: CRED, takeover: ["YmF6cXV4"] },
      fresh,
      slot,
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await pending).stop).toBeNull();
    vi.useRealTimers();

    answer = () => ({ ok: true, data: GRANT });
    expect(await slot.afterConnected({ protocolUserId: CRED })).toEqual({ kind: "keep" });

    expect(calls.map((c) => c.body)).toEqual([
      { subscriptionId: SUB, protocolUserId: CRED, takeover: ["YmF6cXV4"] },
      { subscriptionId: SUB, protocolUserId: CRED, takeover: ["YmF6cXV4"] },
    ]);
    expect(slot.standing()).toBe("held");
  });

  it("says when takeovers have to wait, and does not retry", async () => {
    answer = () => ({
      ok: false,
      error: "Too many device switches",
      status: 429,
      code: "TAKEOVER_LIMIT",
      body: { statusCode: 429, code: "TAKEOVER_LIMIT", retryAfterSec: 1260 },
    });
    const { slot } = session();

    const { stop } = await claimWhileRefreshing(
      { subscriptionId: SUB, protocolUserId: CRED, takeover: ["YmF6cXV4"] },
      fresh,
      slot,
    );

    expect(stop?.notice).toEqual({ kind: "takeoverLimited", retryAfterSec: 1260 });
    expect(stop?.report).toEqual({ kind: "CONNECT", outcome: "REJECTED", reason: "TAKEOVER_LIMIT" });
    expect(calls).toHaveLength(1);
  });

  it("hands a stopped plan to the plan-ended state", async () => {
    answer = () => ({
      ok: false,
      error: "Subscription is not active",
      status: 409,
      code: "SUBSCRIPTION_INACTIVE",
      body: { statusCode: 409, code: "SUBSCRIPTION_INACTIVE", subscriptionStatus: "EXPIRED" },
    });
    const { slot } = session();

    const { stop } = await claimWhileRefreshing({ subscriptionId: SUB, protocolUserId: CRED }, fresh, slot);

    expect(stop).toEqual({
      notice: null,
      report: { kind: "CONNECT", outcome: "REJECTED", reason: "SUBSCRIPTION_INACTIVE" },
      subscriptionStatus: "EXPIRED",
      inactive: true,
    });
  });

  /** The platform always; a label only with a model in it, never the
   * phone's kind -- the reader names that, in its own language. */
  it.each([
    ["an Android phone", "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A; wv) AppleWebKit/537.36", 5, "android", "Pixel 7"],
    ["an Android phone with a reduced user agent", "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36", 5, "android", null],
    ["an iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15", 5, "ios", null],
    ["an iPad", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 5, "ios", "iPad"],
  ])("names %s on the claim by its platform, and by its model only when it has one", async (_name, userAgent, touch, platform, label) => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.stubGlobal("navigator", { userAgent, maxTouchPoints: touch });
    answer = () => ({ ok: true, data: GRANT });
    const { slot } = session();

    await claimWhileRefreshing({ subscriptionId: SUB, protocolUserId: CRED }, fresh, slot);

    expect(calls[0].headers).toEqual({
      "X-Neoxify-Device-Platform": platform,
      ...(label !== null ? { "X-Neoxify-Device-Label": label } : {}),
    });
  });
});

describe("renewing, in the foreground only", () => {
  async function connected() {
    answer = () => ({ ok: true, data: GRANT });
    const s = session();
    await claimWhileRefreshing({ subscriptionId: SUB, protocolUserId: CRED }, fresh, s.slot);
    await s.slot.afterConnected({ protocolUserId: CRED });
    calls.length = 0;
    return s;
  }

  it("renews on the contract's sixty seconds, not on every poll", async () => {
    const { slot, advance } = await connected();
    answer = () => ({ ok: true, data: HELD });

    for (let poll = 1; poll <= 3; poll++) {
      advance(15_000);
      expect(await renewInForeground(slot, () => true)).toEqual({ kind: "keep" });
    }
    expect(calls).toHaveLength(0);

    advance(15_000);
    expect(await renewInForeground(slot, () => true)).toEqual({ kind: "keep" });
    expect(calls.map((c) => c.path)).toEqual(["/customer/vpn/renew"]);
    expect(calls[0].body).toEqual({ subscriptionId: SUB });
  });

  it("asks nothing in the background, however long the phone is away", async () => {
    const { slot, advance } = await connected();
    answer = () => ({ ok: true, data: HELD });

    // Ten minutes of the health poll's timer still firing in a pocket.
    for (let poll = 0; poll < 40; poll++) {
      advance(15_000);
      expect(await renewInForeground(slot, () => false)).toEqual({ kind: "keep" });
    }
    expect(calls).toHaveLength(0);

    // Back in front: one renewal, straight away.
    expect(await renewInForeground(slot, () => true)).toEqual({ kind: "keep" });
    expect(calls).toHaveLength(1);
  });

  it("says who has the slot when the phone was taken over while away, and reports no failed dial", async () => {
    const { slot, advance } = await connected();
    answer = () => ({
      ok: true,
      data: {
        status: "displaced",
        subscriptionId: SUB,
        limit: 1,
        by: { handle: "YmF6cXV4", label: "Windows PC", platform: "windows" },
        at: "2026-10-06T11:02:13.551Z",
      },
    });

    advance(5 * 60_000);
    const event = await renewInForeground(slot, () => true);

    expect(event).toEqual({
      kind: "displaced",
      by: { handle: "YmF6cXV4", label: "Windows PC", platform: "windows" },
      at: "2026-10-06T11:02:13.551Z",
    });
    expect(slot.standing()).toBe("displaced");
    if (event.kind !== "displaced") throw new Error("unreachable");
    const stop = slotStop(event, "whileConnected");
    expect(stop.notice).toEqual({ kind: "displaced", by: event.by, at: event.at });
    // The connect was reported when it happened; a takeover adds no
    // failed dial to anything.
    expect(stop.report).toBeNull();
  });

  it("keeps the tunnel when a renewal cannot reach the API", async () => {
    const { slot, advance } = await connected();
    answer = () => ({ ok: false, error: "Could not reach Neoxify. Check your internet connection." });

    advance(60_000);
    expect(await renewInForeground(slot, () => true)).toEqual({ kind: "keep" });
    expect(slot.standing()).toBe("held");
  });

  it("claims through the tunnel, on the foreground clock, a slot whose first claim went unanswered", async () => {
    vi.useFakeTimers();
    answer = () => "hang";
    const { slot, advance } = session();
    const pending = claimWhileRefreshing({ subscriptionId: SUB, protocolUserId: CRED }, fresh, slot);
    await vi.advanceTimersByTimeAsync(3_000);
    await pending;
    vi.useRealTimers();

    // The claim through the tunnel is refused: the slots were in use all
    // along. The dashboard ends the session and shows where.
    answer = () => ({ ok: false, error: REFUSAL.message, status: 409, code: "DEVICE_LIMIT", body: REFUSAL });
    advance(60_000);
    expect(await renewInForeground(slot, () => false)).toEqual({ kind: "keep" });
    const event = await renewInForeground(slot, () => true);

    expect(event.kind).toBe("refused");
    expect(calls.map((c) => c.path)).toEqual(["/customer/vpn/claim", "/customer/vpn/claim"]);
  });
});

describe("coming back to the foreground", () => {
  function fakeDocument(initial: DocumentVisibilityState) {
    const target = new EventTarget();
    const doc = {
      visibilityState: initial,
      addEventListener: (type: "visibilitychange", listener: () => void) => target.addEventListener(type, listener),
      removeEventListener: (type: "visibilitychange", listener: () => void) =>
        target.removeEventListener(type, listener),
    };
    const become = (state: DocumentVisibilityState) => {
      doc.visibilityState = state;
      target.dispatchEvent(new Event("visibilitychange"));
    };
    return { doc, become };
  }

  it("checks as the app comes back, and not as it goes", () => {
    const { doc, become } = fakeDocument("visible");
    const handler = vi.fn();
    const stop = whenForegrounded(handler, doc);

    become("hidden");
    expect(handler).not.toHaveBeenCalled();
    become("visible");
    expect(handler).toHaveBeenCalledTimes(1);

    stop();
    become("hidden");
    become("visible");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does nothing where there is no document", () => {
    const stop = whenForegrounded(vi.fn(), undefined);
    expect(() => stop()).not.toThrow();
  });
});

describe("the teardown after the slot ends the session", () => {
  it("is down only once the platform says so", async () => {
    const order: string[] = [];
    const verdict = await tearDownForSlot({
      disconnect: async () => void order.push("disconnect"),
      waitForTeardown: async () => {
        order.push("wait");
        return true;
      },
    });
    expect(verdict).toBe("down");
    expect(order).toEqual(["disconnect", "wait"]);
  });

  it("is stuck when the device is still routed through a VPN", async () => {
    expect(
      await tearDownForSlot({ disconnect: () => Promise.resolve(), waitForTeardown: () => Promise.resolve(false) }),
    ).toBe("stuck");
  });

  it("still asks the platform when the disconnect call failed", async () => {
    const waitForTeardown = vi.fn(() => Promise.resolve(true));
    const verdict = await tearDownForSlot({
      disconnect: () => Promise.reject(new Error("plugin not ready")),
      waitForTeardown,
    });
    expect(waitForTeardown).toHaveBeenCalledTimes(1);
    expect(verdict).toBe("down");
  });

  /** Obligation 11: never leave the tunnel up over a refusal. A stuck
   * teardown used to be said once and then left: nothing tried again. */
  it("is tried again until the platform says the tunnel is down, and owed until then", async () => {
    const store = createSlotTeardown();
    const gone = [false, false, true];
    const disconnect = vi.fn(() => Promise.resolve());
    const attempt = slotTeardownAttempt({ disconnect, waitForTeardown: () => Promise.resolve(gone.shift() ?? false) });

    expect(await store.begin(attempt)).toBe("stuck");
    expect(store.state()).toBe("stuck");
    expect(await store.retry(attempt)).toBe("stuck");
    expect(store.owed()).toBe(true);
    expect(await store.retry(attempt)).toBe("down");
    expect(store.owed()).toBe(false);
    expect(disconnect).toHaveBeenCalledTimes(3);

    // Nothing owed: the poll asks nothing more.
    expect(await store.retry(attempt)).toBeNull();
    expect(disconnect).toHaveBeenCalledTimes(3);
  });

  /** The whole path: a claim through the tunnel refused, a teardown that
   * does not finish, the card held back meanwhile, and shown once a
   * retry has the platform's word that the tunnel is down. */
  it("holds a late refusal's card until a retry takes the tunnel down", async () => {
    answer = () => "hang";
    const { slot, advance } = session();
    vi.useFakeTimers();
    const pending = claimWhileRefreshing({ subscriptionId: SUB, protocolUserId: CRED }, fresh, slot);
    await vi.advanceTimersByTimeAsync(3_000);
    await pending;
    vi.useRealTimers();

    answer = () => ({ ok: false, error: REFUSAL.message, status: 409, code: "DEVICE_LIMIT", body: REFUSAL });
    advance(60_000);
    const event = await renewInForeground(slot, () => true);
    if (event.kind !== "refused") throw new Error(`expected a refusal, got ${event.kind}`);
    const notice = slotStop(event, "whileConnected").notice;
    if (!notice) throw new Error("expected a card");

    const store = createSlotTeardown();
    const gone = [false, true];
    const attempt = slotTeardownAttempt({
      disconnect: () => Promise.resolve(),
      waitForTeardown: () => Promise.resolve(gone.shift() ?? false),
    });

    expect(await store.begin(attempt)).toBe("stuck");
    // Still up: no card, and the screen shows it as still disconnecting.
    expect(slotNoticeShown(notice, false)).toBe(false);
    expect(slotTeardownShown(store.owed(), "connected")).toBe("disconnecting");

    expect(await store.retry(attempt)).toBe("down");
    expect(slotNoticeShown(notice, true)).toBe(true);
    expect(store.owed()).toBe(false);
  });

  it("is stuck when the platform cannot be asked", async () => {
    expect(
      await tearDownForSlot({
        disconnect: () => Promise.resolve(),
        waitForTeardown: () => Promise.reject(new Error("no answer")),
      }),
    ).toBe("stuck");
  });
});

describe("Disconnect", () => {
  it("gives the slot back within a second and a half, whether or not the API answers", async () => {
    answer = () => ({ ok: true, data: GRANT });
    const { slot } = session();
    await claimWhileRefreshing({ subscriptionId: SUB, protocolUserId: CRED }, fresh, slot);

    vi.useFakeTimers();
    answer = () => "hang";
    let done = false;
    void slot.release().then(() => (done = true));

    await vi.advanceTimersByTimeAsync(1_500);
    expect(done).toBe(true);
    expect(calls.map((c) => c.path)).toEqual(["/customer/vpn/claim", "/customer/vpn/release"]);
    // Naming the grant it gives back, so a release that lands after the
    // next Connect's claim frees nothing.
    expect(calls[1].body).toEqual({ subscriptionId: SUB, handle: GRANT.handle });
    expect(slot.standing()).toBe("none");
  });

  /** The phone's commonest path in Iran: no answer before dialling, and
   * none through the tunnel either. No grant is known, and a release
   * naming none would free whatever this phone holds -- the slot of a
   * Connect pressed meanwhile included -- so nothing is sent. */
  it("sends no release when no grant was ever answered", async () => {
    answer = () => "hang";
    const { slot } = session();
    vi.useFakeTimers();
    const claimed = claimWhileRefreshing({ subscriptionId: SUB, protocolUserId: CRED }, fresh, slot);
    await vi.advanceTimersByTimeAsync(3_000);
    await claimed;
    expect(slot.standing()).toBe("unclaimed");

    await slot.release();
    expect(calls.map((c) => c.path)).toEqual(["/customer/vpn/claim"]);
  });
});
