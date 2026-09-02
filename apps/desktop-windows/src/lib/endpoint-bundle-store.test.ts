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

describe("the seed bundle shipped in the binary", () => {
  it("is what a fresh install falls back to, so it is not left with nothing", async () => {
    // No stored bundle: the state of every first-ever launch, and the
    // state in which every compiled-in base is on the censored domain.
    store.get.mockResolvedValue(undefined);
    const seeded = await sealed(7);
    vi.resetModules();
    vi.doMock("./seed-bundle.json", () => ({ default: JSON.parse(seeded) }));
    const mod = await import("./endpoint-bundle-store");
    expect((await mod.cachedBundle())?.v).toBe(7);
  });

  it("loses to a stored bundle that is newer", async () => {
    const seeded = await sealed(2);
    const stored = await sealed(9);
    store.get.mockResolvedValue(stored);
    vi.resetModules();
    vi.doMock("./seed-bundle.json", () => ({ default: JSON.parse(seeded) }));
    const mod = await import("./endpoint-bundle-store");
    expect((await mod.cachedBundle())?.v).toBe(9);
  });

  it("wins over a stored bundle that is older, as after an upgrade", async () => {
    const seeded = await sealed(9);
    const stored = await sealed(2);
    store.get.mockResolvedValue(stored);
    vi.resetModules();
    vi.doMock("./seed-bundle.json", () => ({ default: JSON.parse(seeded) }));
    const mod = await import("./endpoint-bundle-store");
    expect((await mod.cachedBundle())?.v).toBe(9);
  });

  it("is inert in the repo, so no node address is committed", async () => {
    const { readFileSync } = await import("node:fs");
    const placeholder = readFileSync("src/lib/seed-bundle.placeholder.json", "utf8");
    const real = await import("./endpoint-bundle");
    expect(await real.verifyBundle(placeholder)).toBeNull();
  });
});

describe("refresh trigger", () => {
  it("runs once per run, not once per request", async () => {
    store.get.mockResolvedValue(undefined);
    const mod = await import("./endpoint-bundle-store");
    mod.resetBundleRefreshForTests();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, text: () => Promise.resolve("") });
    vi.stubGlobal("fetch", fetchMock);
    await mod.maybeRefreshBundle("https://a.example.net/api");
    await mod.maybeRefreshBundle("https://a.example.net/api");
    await mod.maybeRefreshBundle("https://b.example.net/api");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("never throws, so a refresh failure cannot break the request that triggered it", async () => {
    store.get.mockResolvedValue(undefined);
    const mod = await import("./endpoint-bundle-store");
    mod.resetBundleRefreshForTests();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("blocked")));
    await expect(mod.maybeRefreshBundle("https://a.example.net/api")).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});
