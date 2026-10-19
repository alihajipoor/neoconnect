import { afterEach, describe, expect, it, vi } from "vitest";
import { getPublicKeyAsync, signAsync, utils } from "@noble/ed25519";

const store = { get: vi.fn(), set: vi.fn(), save: vi.fn() };
vi.mock("@tauri-apps/plugin-store", () => ({ load: () => Promise.resolve(store) }));

const keys: Record<string, string> = {};
vi.mock("./endpoint-bundle", async (importOriginal) => {
  const real = await importOriginal<typeof import("./endpoint-bundle")>();
  return { ...real, verifyBundle: (raw: string) => real.verifyBundle(raw, keys) };
});

const { isKnownBlockPage, refreshFrom, cachedBundle, setScopeGranterForTests } = await import("./endpoint-bundle-store");

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

  /** Under the HTTP plugin a response is parked on the Rust side, with its
   * connection, until its body is read to the end or cancelled. A 404,
   * 502 or 403 here was neither, and stayed parked for the life of the
   * app. */
  it("lets go of the body of a non-ok response it does not read", async () => {
    store.get.mockResolvedValue(await sealed(3));
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true;
      },
    });
    await refreshFrom("https://a.example.net/api", () =>
      Promise.resolve({ ok: false, text: () => Promise.resolve(""), body }),
    );
    expect(cancelled).toBe(true);
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

/** A list the server signs, under the operator key's statement for it,
 * which runs out at `expires` (Unix seconds). */
async function serverSealed(v: number, expires = Math.floor(Date.now() / 1000) + 3600) {
  if (!keys.primary) await sealed(0);
  const serverPriv = utils.randomPrivateKey();
  const statement = new TextEncoder().encode(
    JSON.stringify({
      kind: "neoxify-bundle-key",
      id: "server-1",
      publicKey: b64(await getPublicKeyAsync(serverPriv)),
      expires,
    }),
  );
  const payload = new TextEncoder().encode(
    JSON.stringify({ v, issuedAt: "x", endpoints: [{ kind: "mirror", url: `https://s${v}.example.org:2096/api` }] }),
  );
  return JSON.stringify({
    payload: b64(payload),
    sig: b64(await signAsync(payload, serverPriv)),
    key: "server-1",
    cert: { payload: b64(statement), sig: b64(await signAsync(statement, OPERATOR_KEY)), key: "primary" },
  });
}

/** Answers each path with its own body; anything else is a 404. */
function byPath(bodies: Record<string, string>) {
  const asked: string[] = [];
  const fetcher = (url: string) => {
    asked.push(url);
    const path = Object.keys(bodies).find((p) => url.endsWith(p));
    return Promise.resolve(path ? okResponse(bodies[path]) : { ok: false, text: () => Promise.resolve("") });
  };
  return { fetcher, asked };
}

describe("the server-signed list", () => {
  it("is asked for first, and adopted when it is the newest", async () => {
    store.get.mockResolvedValue(await sealed(7));
    store.set.mockClear();
    const server = await serverSealed(105);
    const offline = await sealed(8);
    const { fetcher, asked } = byPath({ "/endpoints/bundle2": server, "/endpoints/bundle": offline });

    const out = await refreshFrom("https://a.example.net/api", fetcher);

    expect(out?.v).toBe(105);
    expect(asked[0]).toBe("https://a.example.net/api/endpoints/bundle2");
    expect(store.set).toHaveBeenCalledWith("bundle", server);
    expect(store.set).not.toHaveBeenCalledWith("bundle", offline);
  });

  // Every backend before bundle2, and any with none published yet.
  it("leaves the offline list to be adopted when there is none", async () => {
    store.get.mockResolvedValue(await sealed(7));
    store.set.mockClear();
    const offline = await sealed(8);
    const { fetcher } = byPath({ "/endpoints/bundle": offline });

    expect((await refreshFrom("https://a.example.net/api", fetcher))?.v).toBe(8);
    expect(store.set).toHaveBeenCalledWith("bundle", offline);
  });

  it("is not adopted over a newer offline list", async () => {
    store.get.mockResolvedValue(await sealed(7));
    store.set.mockClear();
    const offline = await sealed(200);
    const { fetcher } = byPath({ "/endpoints/bundle2": await serverSealed(105), "/endpoints/bundle": offline });

    expect((await refreshFrom("https://a.example.net/api", fetcher))?.v).toBe(200);
    expect(store.set.mock.calls.filter(([key]) => key === "bundle").slice(-1)).toEqual([["bundle", offline]]);
  });
});

/** The store key by key, for the tests that read both slots. */
function slotted(initial: Record<string, string>): Map<string, string> {
  const slots = new Map(Object.entries(initial));
  store.get.mockImplementation((key: string) => Promise.resolve(slots.get(key)));
  store.set.mockImplementation((key: string, value: string) => {
    slots.set(key, value);
    return Promise.resolve();
  });
  return slots;
}

/** The store module again, built with a seed of version `v`. */
async function builtWithSeed(v: number) {
  const seeded = await sealed(v);
  vi.resetModules();
  vi.doMock("./seed-bundle.json", () => ({ default: JSON.parse(seeded) }));
  return await import("./endpoint-bundle-store");
}

describe("a server list whose statement has run out", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    store.get.mockReset();
    store.set.mockReset();
  });

  // Seed v7's hosts blocked, offline v8 published to move clients off
  // them, then a server list. A year on its statement runs out -- or the
  // device's clock runs ahead of it -- and the client went back to v7,
  // the seed it was built with: the blocked hosts, with nowhere left to
  // fetch a new list from.
  it("falls back to the newest offline list held, not the seed", async () => {
    const mod = await builtWithSeed(7);
    const offline = await sealed(8);
    const slots = slotted({ bundle: offline });
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const server = await serverSealed(105, expires);

    await mod.refreshFrom(
      "https://a.example.net/api",
      byPath({ "/endpoints/bundle2": server, "/endpoints/bundle": offline }).fetcher,
    );
    expect(slots.get("bundle")).toBe(server);
    expect((await mod.cachedBundle())?.v).toBe(105);

    vi.spyOn(Date, "now").mockReturnValue(expires * 1000);
    const granted: string[] = [];
    mod.setScopeGranterForTests((envelope) => {
      granted.push(envelope);
      return Promise.resolve();
    });
    expect((await mod.cachedBundle())?.v).toBe(8);
    // And the scope is the hosts of the list in force.
    expect(granted).toEqual([offline]);
  });

  // The offline list is fetched on every refresh, and was dropped
  // whenever it was not newer than the server list held.
  it("keeps a newer offline list fetched beneath the server list in force", async () => {
    const mod = await builtWithSeed(7);
    const server = await serverSealed(105);
    const slots = slotted({ bundle: server });
    const offline = await sealed(9);

    const out = await mod.refreshFrom(
      "https://a.example.net/api",
      byPath({ "/endpoints/bundle2": server, "/endpoints/bundle": offline }).fetcher,
    );

    expect(out?.v).toBe(105);
    expect(slots.get("bundle")).toBe(server);
    expect(slots.get("offline")).toBe(offline);
  });

  it("is not the offline list's to fall back to while it verifies", async () => {
    const mod = await builtWithSeed(7);
    slotted({ bundle: await serverSealed(105), offline: await sealed(9) });
    expect((await mod.cachedBundle())?.v).toBe(105);
  });

  it("falls back to the seed when the seed is the newer", async () => {
    const mod = await builtWithSeed(7);
    const expires = Math.floor(Date.now() / 1000) + 3600;
    slotted({ bundle: await serverSealed(105, expires), offline: await sealed(6) });
    vi.spyOn(Date, "now").mockReturnValue(expires * 1000);
    expect((await mod.cachedBundle())?.v).toBe(7);
  });

  // A source serving a server list at the offline path: it expires like
  // any other, so it is no fallback.
  it("never keeps a server-signed list as the offline one", async () => {
    const mod = await builtWithSeed(7);
    const slots = slotted({ bundle: await sealed(8) });
    const server = await serverSealed(105);

    await mod.refreshFrom("https://a.example.net/api", byPath({ "/endpoints/bundle": server }).fetcher);

    expect(slots.get("bundle")).toBe(server);
    expect(slots.has("offline")).toBe(false);
  });
});

describe("the HTTP scope", () => {
  it("is widened to the hosts of a list as it is adopted", async () => {
    const granted: string[] = [];
    setScopeGranterForTests((envelope) => {
      granted.push(envelope);
      return Promise.resolve();
    });
    store.get.mockResolvedValue(await sealed(7));
    const server = await serverSealed(106);

    await refreshFrom("https://a.example.net/api", byPath({ "/endpoints/bundle2": server }).fetcher);

    expect(granted).toContain(server);
    setScopeGranterForTests(null);
  });

  // A list adopted in an earlier run names hosts this run has not been
  // granted: they are granted before the list is handed out.
  it("is widened to the held list's hosts before anything reads it", async () => {
    const granted: string[] = [];
    setScopeGranterForTests((envelope) => {
      granted.push(envelope);
      return Promise.resolve();
    });
    const held = await sealed(9);
    store.get.mockResolvedValue(held);

    await cachedBundle();
    await cachedBundle();

    expect(granted).toEqual([held]);
    setScopeGranterForTests(null);
  });

  // The web portal and the macOS app have no such command.
  it("costs nothing where the command is missing", async () => {
    setScopeGranterForTests(() => Promise.reject(new Error("command grant_bundle_scope not found")));
    store.get.mockResolvedValue(await sealed(7));
    const offline = await sealed(10);

    expect((await refreshFrom("https://a.example.net/api", byPath({ "/endpoints/bundle": offline }).fetcher))?.v).toBe(10);
    expect((await cachedBundle())?.v).toBe(7);
    setScopeGranterForTests(null);
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
    // One refresh: the server-signed list, then the offline one.
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://a.example.net/api/endpoints/bundle2",
      "https://a.example.net/api/endpoints/bundle",
    ]);
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

/** For a client only the relay of last resort reaches -- every ordinary
 * address blocked, the 2026-10-17 case -- the lists were never fetched at
 * all: the refresh ran only after an ordinary address answered. */
describe("refresh through the relay", () => {
  it("asks for both lists by path, once a run", async () => {
    store.get.mockResolvedValue(undefined);
    const mod = await import("./endpoint-bundle-store");
    mod.resetBundleRefreshForTests();
    const { fetcher, asked } = byPath({});

    await mod.maybeRefreshBundleThroughRelay(fetcher);
    await mod.maybeRefreshBundleThroughRelay(fetcher);

    expect(asked).toEqual(["/endpoints/bundle2", "/endpoints/bundle"]);
  });

  it("adopts a newer list it brings, as one from any address", async () => {
    store.get.mockResolvedValue(await sealed(7));
    store.set.mockClear();
    const mod = await import("./endpoint-bundle-store");
    mod.resetBundleRefreshForTests();
    const server = await serverSealed(107);

    await mod.maybeRefreshBundleThroughRelay(byPath({ "/endpoints/bundle2": server }).fetcher);

    expect(store.set).toHaveBeenCalledWith("bundle", server);
  });

  // An ordinary address that answered has been asked already, and costs
  // the relay's budget nothing.
  it("is not asked once an ordinary address has answered", async () => {
    store.get.mockResolvedValue(undefined);
    const mod = await import("./endpoint-bundle-store");
    mod.resetBundleRefreshForTests();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, text: () => Promise.resolve("") }));
    await mod.maybeRefreshBundle("https://a.example.net/api");
    vi.unstubAllGlobals();
    const { fetcher, asked } = byPath({});

    await mod.maybeRefreshBundleThroughRelay(fetcher);

    expect(asked).toEqual([]);
  });

  it("never throws", async () => {
    store.get.mockResolvedValue(undefined);
    const mod = await import("./endpoint-bundle-store");
    mod.resetBundleRefreshForTests();
    await expect(mod.maybeRefreshBundleThroughRelay(() => Promise.reject(new Error("relay")))).resolves.toBeUndefined();
  });
});

/** The relay's refresh waits on relay calls queued ahead of it, and an
 * ordinary address can answer meanwhile, which starts the other. Side by
 * side, each compared what it fetched with the lists held when it began,
 * and the later to finish stored its list over the newer one. */
describe("two refreshes at once", () => {
  afterEach(() => {
    store.get.mockReset();
    store.set.mockReset();
  });

  it("never store an older list over the one the other just adopted", async () => {
    const mod = await builtWithSeed(7);
    const held = await sealed(100);
    const slots = slotted({ bundle: held, offline: held });
    const newer = await sealed(120);
    const older = await sealed(110);

    /** Answers the offline path once `open` is called; anything else is
     * a 404. */
    function gated(body: string) {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => (open = () => resolve()));
      const asked: string[] = [];
      const fetcher = async (url: string) => {
        asked.push(url);
        if (!url.endsWith("/endpoints/bundle")) return { ok: false, text: () => Promise.resolve("") };
        await opened;
        return okResponse(body);
      };
      return { fetcher, asked, open };
    }
    const relay = gated(newer);
    const ordinary = gated(older);

    const throughRelay = mod.refreshFrom("", relay.fetcher);
    const direct = mod.refreshFrom("https://a.example.net/api", ordinary.fetcher);
    await vi.waitFor(() => expect(relay.asked).toContain("/endpoints/bundle"));
    // Time for a second refresh not made to wait to read the store and
    // ask; it then holds v100 as the list to beat.
    await new Promise((resolve) => setTimeout(resolve, 50));

    relay.open();
    expect((await throughRelay)?.v).toBe(120);
    ordinary.open();
    expect((await direct)?.v).toBe(120);

    expect(slots.get("bundle")).toBe(newer);
    expect(slots.get("offline")).toBe(newer);
    expect((await mod.cachedBundle())?.v).toBe(120);
  });
});
