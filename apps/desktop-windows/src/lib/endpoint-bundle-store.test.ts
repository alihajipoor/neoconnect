import { describe, expect, it, vi } from "vitest";
import { getPublicKeyAsync, signAsync, utils } from "@noble/ed25519";

const store = { get: vi.fn(), set: vi.fn(), save: vi.fn() };
vi.mock("@tauri-apps/plugin-store", () => ({ load: () => Promise.resolve(store) }));

const keys: Record<string, string> = {};
vi.mock("./endpoint-bundle", async (importOriginal) => {
  const real = await importOriginal<typeof import("./endpoint-bundle")>();
  return { ...real, verifyBundle: (raw: string) => real.verifyBundle(raw, keys) };
});

const { isKnownBlockPage, refreshFrom, cachedBundle } = await import("./endpoint-bundle-store");

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
/** One operator key for the whole suite. Re-keying between calls was a
 * fixture bug that made a held bundle stop verifying and looked exactly
 * like the code rejecting it. */
const OPERATOR_KEY = utils.randomPrivateKey();

async function sealed(v: number, priv: Uint8Array = OPERATOR_KEY) {
  if (priv === OPERATOR_KEY) keys.primary = b64(await getPublicKeyAsync(priv));
  const payload = new TextEncoder().encode(
    JSON.stringify({ v, issuedAt: "x", endpoints: [{ kind: "panel", url: `https://v${v}.example.net/api` }] }),
  );
  return JSON.stringify({ payload: b64(payload), sig: b64(await signAsync(payload, priv)), key: "primary" });
}
const okResponse = (body: string) => ({ ok: true, text: () => Promise.resolve(body) });

describe("bundle refresh", () => {
  it("adopts a newer signed bundle and writes it through", async () => {
    const held = await sealed(1);
    const fresh = await sealed(2);
    store.get.mockResolvedValue(held);
    store.set.mockClear();

    const out = await refreshFrom("https://a.example.net/api", () => Promise.resolve(okResponse(fresh)));

    expect(out?.v).toBe(2);
    expect(store.set).toHaveBeenCalledWith("bundle", fresh);
  });

  // The replay case: a genuinely signed OLD list would walk a client back
  // onto addresses that have since been retired.
  it("keeps the held bundle when the served one is older", async () => {
    const held = await sealed(5);
    const older = await sealed(2);
    store.get.mockResolvedValue(held);
    store.set.mockClear();

    const out = await refreshFrom("https://a.example.net/api", () => Promise.resolve(okResponse(older)));

    expect(out?.v).toBe(5);
    expect(store.set).not.toHaveBeenCalled();
  });

  // Signed by somebody else: newer, well-formed, and not the operator.
  it("keeps the held bundle when the signature is from another key", async () => {
    const held = await sealed(1);
    const forged = await sealed(9, utils.randomPrivateKey());
    store.get.mockResolvedValue(held);
    store.set.mockClear();

    const out = await refreshFrom("https://a.example.net/api", () => Promise.resolve(okResponse(forged)));

    expect(store.set).not.toHaveBeenCalled();
    expect(out?.v).toBe(1);
  });

  // 404 is the ordinary answer before the operator has published one.
  it("treats a non-ok response as nothing to do", async () => {
    const held = await sealed(3);
    store.get.mockResolvedValue(held);
    store.set.mockClear();

    const out = await refreshFrom("https://a.example.net/api", () =>
      Promise.resolve({ ok: false, text: () => Promise.resolve("") }),
    );

    expect(out?.v).toBe(3);
    expect(store.set).not.toHaveBeenCalled();
  });

  // This runs beside real work; a network failure here must never be the
  // reason a request did not happen.
  it("never throws when the fetch fails", async () => {
    store.get.mockResolvedValue(await sealed(4));
    const out = await refreshFrom("https://a.example.net/api", () => Promise.reject(new Error("blocked")));
    expect(out?.v).toBe(4);
  });

  it("returns null rather than throwing when nothing is cached", async () => {
    store.get.mockResolvedValue(undefined);
    expect(await cachedBundle()).toBeNull();
  });
});

describe("block-page detection", () => {
  it("recognises Iran's sinkhole range", () => {
    expect(isKnownBlockPage("10.10.34.34")).toBe(true);
    expect(isKnownBlockPage("10.10.34.35")).toBe(true);
  });

  it("does not flag ordinary private or public addresses", () => {
    for (const a of ["10.10.35.1", "192.168.1.1", "203.0.113.10", "10.0.34.34"]) {
      expect(isKnownBlockPage(a)).toBe(false);
    }
  });
});
