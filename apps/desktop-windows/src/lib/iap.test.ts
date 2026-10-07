import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./api";

/** The App Store recovery sweep, with StoreKit and our API stood in for.
 *
 * The defect these pin: after redeeming one unfinished transaction the
 * sweep called `vpn_iap_finish` with no id, which the iOS side took as
 * "finish every unfinished transaction". With two waiting, the second
 * was finished before its own redeem ran, and if that redeem failed the
 * purchase was gone -- StoreKit never lists a finished transaction
 * again. Nothing here has run against StoreKit or a device. */

const invoke = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));

const apiRequest = vi.fn<(path: string, init?: RequestInit) => Promise<ApiResult<unknown>>>();
vi.mock("./api", () => ({ apiRequest: (path: string, init?: RequestInit) => apiRequest(path, init) }));
vi.mock("./customer", () => ({ getPlans: async () => ({ ok: true, data: [] }) }));
vi.mock("./distribution", () => ({ IS_STORE_BUILD: true }));

const { sweepUnfinishedPurchases, transactionIdOf } = await import("./iap");

/** A JWS-shaped string whose payload names `transactionId`. The
 * signature is junk: only the server checks it, and it is stood in for. */
function jws(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "ES256" })}.${encode(payload)}.c2lnbmF0dXJl`;
}

const FIRST = jws({ transactionId: "2000000111111111", productId: "plan.month" });
const SECOND = jws({ transactionId: "2000000222222222", productId: "plan.month" });

function finishes(): unknown[] {
  return invoke.mock.calls.filter(([cmd]) => cmd === "vpn_iap_finish").map(([, args]) => args);
}

beforeEach(() => {
  invoke.mockReset();
  apiRequest.mockReset();
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", maxTouchPoints: 5 });
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  invoke.mockImplementation(async (cmd) => {
    if (cmd === "vpn_iap_unfinished") return { signedTransactions: [FIRST, SECOND] };
    return {};
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("transactionIdOf", () => {
  it("reads StoreKit's decimal-string id from the payload", () => {
    expect(transactionIdOf(FIRST)).toBe("2000000111111111");
  });

  it("accepts a numeric id that fits exactly", () => {
    expect(transactionIdOf(jws({ transactionId: 42 }))).toBe("42");
  });

  it("answers null for anything it cannot read, rather than guessing", () => {
    expect(transactionIdOf("not-a-jws")).toBeNull();
    expect(transactionIdOf("a.%%%.c")).toBeNull();
    expect(transactionIdOf(jws({ productId: "plan.month" }))).toBeNull();
    expect(transactionIdOf(jws({ transactionId: "12abc" }))).toBeNull();
  });
});

describe("sweepUnfinishedPurchases", () => {
  it("finishes each redeemed transaction by its own id, never all of them", async () => {
    apiRequest.mockResolvedValue({ ok: true, data: { subscriptionId: "s", alreadyRedeemed: false } });
    await expect(sweepUnfinishedPurchases()).resolves.toBe(2);
    expect(finishes()).toEqual([{ transactionId: "2000000111111111" }, { transactionId: "2000000222222222" }]);
  });

  it("leaves a transaction whose redeem failed unfinished, after finishing the one before it", async () => {
    // The lost-purchase sequence: the first redeems, the second does not.
    apiRequest
      .mockResolvedValueOnce({ ok: true, data: { subscriptionId: "s", alreadyRedeemed: false } })
      .mockResolvedValueOnce({ ok: false, error: "network" });
    await expect(sweepUnfinishedPurchases()).resolves.toBe(1);
    expect(finishes()).toEqual([{ transactionId: "2000000111111111" }]);
  });

  it("finishes nothing for a transaction whose id cannot be read", async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === "vpn_iap_unfinished") return { signedTransactions: ["no.payload-here.sig"] };
      return {};
    });
    apiRequest.mockResolvedValue({ ok: true, data: { subscriptionId: "s", alreadyRedeemed: false } });
    await sweepUnfinishedPurchases();
    expect(finishes()).toEqual([]);
  });

  it("never asks the native side to finish with a null id", async () => {
    apiRequest.mockResolvedValue({ ok: true, data: { subscriptionId: "s", alreadyRedeemed: true } });
    await sweepUnfinishedPurchases();
    expect(finishes().some((args) => (args as { transactionId: unknown }).transactionId == null)).toBe(false);
  });
});
