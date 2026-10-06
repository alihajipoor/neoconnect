import { beforeEach, describe, expect, it, vi } from "vitest";

/** The device-slot calls against the HTTP contract in docs/device-slots.md,
 * through the real `apiRequest` with only the transport stood in for.
 *
 * What these establish is the client's reading of the contract: which
 * answers stop a dial (a 409 or a 429 that says why) and which do not
 * (everything else, including no answer in time), what is sent, and that
 * none of it is a sign-out. Nothing here has been seen against the real
 * backend or a real network; see the journal entry. */

const ENDPOINTS = ["https://a.example", "https://b.example"];

type Reply = { status: number; body?: unknown } | "hang" | "unreachable";
const replies: Record<string, Reply[]> = {};
const sent: { url: string; headers: Record<string, string>; body: unknown }[] = [];

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string, init?: RequestInit) => {
    sent.push({
      url,
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const path = new URL(url).pathname;
    const reply = replies[path]?.shift();
    if (reply === undefined || reply === "unreachable") return Promise.reject(new TypeError("network error"));
    if (reply === "hang") {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    return Promise.resolve(
      new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "content-type": "application/json" },
      }),
    );
  },
}));
vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve(ENDPOINTS),
  rememberEndpoint: () => Promise.resolve(),
}));
vi.mock("./endpoint-bundle-store", () => ({ maybeRefreshBundle: () => Promise.resolve() }));

let stored: { accessToken: string; refreshToken: string } | null = null;
vi.mock("./session", () => ({
  getTokens: () => Promise.resolve(stored),
  setTokens: (t: { accessToken: string; refreshToken: string }) => {
    stored = t;
    return Promise.resolve();
  },
  clearTokens: () => {
    stored = null;
    return Promise.resolve();
  },
}));

const { claimSlot, renewSlot, releaseSlot, refusalReport, refusalFrom } = await import("./device-slots");
const { configureDeviceIdentity } = await import("./device-identity");
const { onSessionRevoked } = await import("./session-revoked");
const { failedDial } = await import("./attempts");

let announced = 0;
onSessionRevoked(() => {
  announced += 1;
});

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

const DEVICE_LIMIT = {
  statusCode: 409,
  code: "DEVICE_LIMIT",
  message: "Your plan allows 1 device at a time.",
  limit: 1,
  holders: [
    {
      handle: "Zm9vYmFyYmF6",
      label: "Windows PC",
      platform: "windows",
      since: "2026-10-06T10:32:04.120Z",
      lastSeen: "2026-10-06T10:55:41.004Z",
    },
  ],
};

beforeEach(() => {
  for (const key of Object.keys(replies)) delete replies[key];
  sent.length = 0;
  stored = { accessToken: "access", refreshToken: "refresh" };
  announced = 0;
  configureDeviceIdentity({ platform: "windows" });
});

describe("claim", () => {
  it("sends the contract's fields and the device headers", async () => {
    replies["/customer/vpn/claim"] = [{ status: 200, body: GRANT }];

    const outcome = await claimSlot({ subscriptionId: SUB, protocolUserId: CRED });

    expect(outcome).toEqual({
      kind: "granted",
      grant: { enforced: true, limit: 1, handle: "Zm9vYmFyYmF6", renewEverySec: 60, staleAfterSec: 90 },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://a.example/customer/vpn/claim");
    // Nothing the API does not know: it rejects unknown fields with 400.
    expect(sent[0].body).toEqual({ subscriptionId: SUB, protocolUserId: CRED });
    expect(sent[0].headers["X-Neoxify-Device-Platform"]).toBe("windows");
    expect(sent[0].headers["X-Neoxify-Device-Label"]).toBe("Windows PC");
    expect(sent[0].headers.Authorization).toBe("Bearer access");
  });

  it("names the holders to take over only when asked to", async () => {
    replies["/customer/vpn/claim"] = [{ status: 200, body: GRANT }];

    await claimSlot({ subscriptionId: SUB, takeover: ["Zm9vYmFyYmF6", "", "x".repeat(65)] });

    // Within the server's bounds, so a stray value cannot turn the
    // takeover into a 400.
    expect(sent[0].body).toEqual({ subscriptionId: SUB, takeover: ["Zm9vYmFyYmF6"] });
  });

  it("reads an unenforced grant as a grant", async () => {
    replies["/customer/vpn/claim"] = [
      { status: 200, body: { ...GRANT, enforced: false, handle: null, limit: null } },
    ];
    const outcome = await claimSlot({ subscriptionId: SUB });
    expect(outcome).toEqual({
      kind: "granted",
      grant: { enforced: false, limit: null, handle: null, renewEverySec: 60, staleAfterSec: 90 },
    });
  });

  it("turns a 409 DEVICE_LIMIT into a refusal naming where Neoxify is in use", async () => {
    replies["/customer/vpn/claim"] = [{ status: 409, body: DEVICE_LIMIT }];

    const outcome = await claimSlot({ subscriptionId: SUB });

    expect(outcome).toEqual({
      kind: "refused",
      refusal: {
        limit: 1,
        holders: [
          {
            handle: "Zm9vYmFyYmF6",
            label: "Windows PC",
            platform: "windows",
            since: "2026-10-06T10:32:04.120Z",
            lastSeen: "2026-10-06T10:55:41.004Z",
          },
        ],
      },
    });
  });

  /** The apps end the session on 401. A refusal must never be read
   * that way -- it would sign somebody out for pressing Connect on a
   * second device. */
  it("is not a sign-out", async () => {
    replies["/customer/vpn/claim"] = [{ status: 409, body: DEVICE_LIMIT }];
    await claimSlot({ subscriptionId: SUB });
    expect(stored).not.toBeNull();
    expect(announced).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("reads SUBSCRIPTION_INACTIVE and TAKEOVER_LIMIT", async () => {
    replies["/customer/vpn/claim"] = [
      {
        status: 409,
        body: { statusCode: 409, code: "SUBSCRIPTION_INACTIVE", message: "x", subscriptionStatus: "EXPIRED" },
      },
      { status: 429, body: { statusCode: 429, code: "TAKEOVER_LIMIT", message: "x", retryAfterSec: 1260 } },
    ];
    expect(await claimSlot({ subscriptionId: SUB })).toEqual({ kind: "inactive", subscriptionStatus: "EXPIRED" });
    expect(await claimSlot({ subscriptionId: SUB, takeover: ["h"] })).toEqual({
      kind: "takeoverLimited",
      retryAfterSec: 1260,
    });
  });

  describe("never blocks a connect on anything but a definite refusal", () => {
    it("dials anyway when nothing answers within the budget", async () => {
      replies["/customer/vpn/claim"] = ["hang", "hang"];
      const started = Date.now();

      const outcome = await claimSlot({ subscriptionId: SUB }, 50);

      expect(outcome.kind).toBe("unanswered");
      expect(outcome.kind === "unanswered" && outcome.retryable).toBe(true);
      expect(Date.now() - started).toBeLessThan(1_000);
      // The first address only: once the budget is spent no further
      // mirror is dialled for it.
      expect(sent.map((s) => s.url)).toEqual(["https://a.example/customer/vpn/claim"]);
    });

    it("dials anyway when the API cannot be reached", async () => {
      replies["/customer/vpn/claim"] = ["unreachable", "unreachable"];
      const outcome = await claimSlot({ subscriptionId: SUB });
      expect(outcome).toMatchObject({ kind: "unanswered", retryable: true });
    });

    it("dials anyway on a 5xx, and on a throttle that is not the takeover limit", async () => {
      replies["/customer/vpn/claim"] = [{ status: 502 }, { status: 429, body: { message: "Too Many Requests" } }];
      expect(await claimSlot({ subscriptionId: SUB })).toMatchObject({ kind: "unanswered", retryable: true });
      expect(await claimSlot({ subscriptionId: SUB })).toMatchObject({ kind: "unanswered", retryable: true });
    });

    /** A backend from before device slots has no such route. Dial, and
     * do not keep asking a question it cannot answer. */
    it("dials anyway on a 404, and does not ask again", async () => {
      replies["/customer/vpn/claim"] = [{ status: 404, body: { message: "Cannot POST /customer/vpn/claim" } }];
      expect(await claimSlot({ subscriptionId: SUB })).toMatchObject({ kind: "unanswered", retryable: false });
    });

    it("keeps to the budget even while the token is being refreshed", async () => {
      // An expired access token: the claim's 401 sends apiRequest off to
      // refresh, and that request does not carry the claim's signal.
      replies["/customer/vpn/claim"] = [{ status: 401 }];
      replies["/customer-auth/refresh"] = ["hang", "hang"];
      const started = Date.now();

      const outcome = await claimSlot({ subscriptionId: SUB }, 50);

      expect(outcome.kind).toBe("unanswered");
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });

  it("reports a signed-out device as signed out, which apiRequest has announced", async () => {
    replies["/customer/vpn/claim"] = [{ status: 401 }];
    replies["/customer-auth/refresh"] = [{ status: 401 }];
    const outcome = await claimSlot({ subscriptionId: SUB });
    expect(outcome).toEqual({ kind: "signedOut" });
    expect(announced).toBe(1);
  });
});

describe("refresh names the device", () => {
  it("sends the device headers on the token refresh", async () => {
    replies["/customer/vpn/claim"] = [{ status: 401 }, { status: 200, body: GRANT }];
    replies["/customer-auth/refresh"] = [{ status: 200, body: { accessToken: "a2", refreshToken: "r2" } }];

    await claimSlot({ subscriptionId: SUB });

    const refresh = sent.find((s) => s.url.endsWith("/customer-auth/refresh"));
    expect(refresh?.headers["X-Neoxify-Device-Platform"]).toBe("windows");
    expect(refresh?.headers["X-Neoxify-Device-Label"]).toBe("Windows PC");
    expect(refresh?.body).toEqual({ refreshToken: "refresh" });
  });
});

describe("renew", () => {
  it("reads held, displaced and inactive", async () => {
    replies["/customer/vpn/renew"] = [
      { status: 200, body: { status: "held", enforced: true, subscriptionId: SUB, limit: 1, handle: "h", renewEverySec: 60, staleAfterSec: 90 } },
      {
        status: 200,
        body: {
          status: "displaced",
          subscriptionId: SUB,
          limit: 1,
          by: { handle: "YmF6cXV4", label: "Android phone (Pixel 7)", platform: "android" },
          at: "2026-10-06T11:02:13.551Z",
        },
      },
      { status: 200, body: { status: "inactive", subscriptionId: SUB, subscriptionStatus: "SUSPENDED" } },
    ];

    expect(await renewSlot(SUB)).toEqual({
      kind: "held",
      grant: { enforced: true, limit: 1, handle: "h", renewEverySec: 60, staleAfterSec: 90 },
    });
    expect(await renewSlot(SUB)).toEqual({
      kind: "displaced",
      by: { handle: "YmF6cXV4", label: "Android phone (Pixel 7)", platform: "android" },
      at: "2026-10-06T11:02:13.551Z",
    });
    expect(await renewSlot(SUB)).toEqual({ kind: "inactive", subscriptionStatus: "SUSPENDED" });
    // Only the subscription: renew takes nothing else.
    expect(sent[0].body).toEqual({ subscriptionId: SUB });
  });

  it("changes nothing when the API cannot be reached", async () => {
    replies["/customer/vpn/renew"] = ["hang", "hang"];
    expect(await renewSlot(SUB, 50)).toMatchObject({ kind: "unanswered" });
  });

  it("keeps the renewal interval within sense", async () => {
    replies["/customer/vpn/renew"] = [
      { status: 200, body: { status: "held", enforced: true, limit: 1, handle: "h", renewEverySec: 0 } },
      { status: 200, body: { status: "held", enforced: true, limit: 1, handle: "h", renewEverySec: 86_400 } },
    ];
    const first = await renewSlot(SUB);
    const second = await renewSlot(SUB);
    expect(first.kind === "held" && first.grant.renewEverySec).toBe(60);
    expect(second.kind === "held" && second.grant.renewEverySec).toBe(300);
  });

  it("keeps the stale interval within sense too, and the contract's ninety seconds when unsaid", async () => {
    replies["/customer/vpn/renew"] = [
      { status: 200, body: { status: "held", enforced: true, limit: 1, handle: "h", staleAfterSec: 1 } },
      { status: 200, body: { status: "held", enforced: true, limit: 1, handle: "h" } },
    ];
    const first = await renewSlot(SUB);
    const second = await renewSlot(SUB);
    expect(first.kind === "held" && first.grant.staleAfterSec).toBe(30);
    expect(second.kind === "held" && second.grant.staleAfterSec).toBe(90);
  });
});

describe("release", () => {
  /** A release without a handle frees whatever the device holds -- a
   * late one, the slot a Connect pressed since has just been granted. */
  it("names the subscription and the grant it gives back, and nothing else", async () => {
    replies["/customer/vpn/release"] = [{ status: 204 }];
    await releaseSlot({ subscriptionId: SUB, handle: "Zm9vYmFyYmF6" });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://a.example/customer/vpn/release");
    expect(sent[0].body).toEqual({ subscriptionId: SUB, handle: "Zm9vYmFyYmF6" });
  });

  it("is over within its budget when nothing answers, and never throws", async () => {
    replies["/customer/vpn/release"] = ["hang", "hang"];
    const started = Date.now();
    await expect(releaseSlot({ subscriptionId: SUB, handle: "h" }, 50)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("a refusal is a limit, not a failed dial", () => {
  it("reports REJECTED with no ladder, so no route is marked as failing", () => {
    for (const code of ["DEVICE_LIMIT", "SUBSCRIPTION_INACTIVE", "TAKEOVER_LIMIT"] as const) {
      const report = refusalReport(code);
      expect(report).toEqual({ kind: "CONNECT", outcome: "REJECTED", reason: code });
      expect(report.attempts).toBeUndefined();
      expect(report.routeId).toBeUndefined();
    }
  });

  it("records no dial for the concurrency class", () => {
    expect(failedDial("route-1", "concurrentLimit")).toBeNull();
  });

  it("drops a holder that cannot be taken over, and keeps the rest", () => {
    expect(
      refusalFrom({
        limit: 2,
        holders: [{ label: "x" }, { handle: "ok", label: null, since: "not a time" }, "junk"],
      }),
    ).toEqual({ limit: 2, holders: [{ handle: "ok", label: null, platform: null, since: null, lastSeen: null }] });
  });
});
