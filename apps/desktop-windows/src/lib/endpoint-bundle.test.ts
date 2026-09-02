import { describe, expect, it } from "vitest";
import { getPublicKeyAsync, signAsync, utils } from "@noble/ed25519";
import { isNewer, orderedBases, verifyBundle, type EndpointBundle } from "./endpoint-bundle";

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Signs a real envelope with a throwaway key, so these exercise the
 * actual signature path rather than a stub that would pass whatever it
 * was handed. */
async function sealed(bundle: unknown, keyId = "primary") {
  const priv = utils.randomPrivateKey();
  const pub = await getPublicKeyAsync(priv);
  const payload = new TextEncoder().encode(JSON.stringify(bundle));
  const sig = await signAsync(payload, priv);
  return {
    raw: JSON.stringify({ payload: toBase64(payload), sig: toBase64(sig), key: keyId }),
    keys: { [keyId]: toBase64(pub) },
    payload,
    priv,
  };
}

const GOOD: EndpointBundle = {
  v: 4,
  issuedAt: "2026-09-02T00:00:00Z",
  endpoints: [
    { kind: "panel", url: "https://panel.example.net/api" },
    { kind: "panel", url: "https://198.51.100.10/api", pin: "sha256/AAAA" },
    { kind: "mirror", url: "https://node.example.net:2053/api", region: "ir" },
  ],
};

describe("endpoint bundle verification", () => {
  it("accepts a bundle signed by a known key", async () => {
    const { raw, keys } = await sealed(GOOD);
    const out = await verifyBundle(raw, keys);
    expect(out?.v).toBe(4);
    expect(out?.endpoints).toHaveLength(3);
  });

  // The whole point of signing: a censor who can serve the file cannot
  // change what is in it.
  it("rejects a payload altered after signing", async () => {
    const { raw, keys } = await sealed(GOOD);
    const envelope = JSON.parse(raw);
    const forged = { ...GOOD, endpoints: [{ kind: "panel", url: "https://attacker.example/api" }] };
    envelope.payload = toBase64(new TextEncoder().encode(JSON.stringify(forged)));
    expect(await verifyBundle(JSON.stringify(envelope), keys)).toBeNull();
  });

  it("rejects a bundle signed by a key it does not know", async () => {
    const { raw } = await sealed(GOOD);
    const other = await sealed(GOOD);
    // Valid signature, valid structure, wrong signer.
    expect(await verifyBundle(raw, other.keys)).toBeNull();
  });

  it("rejects an unknown key id even when the signature is real", async () => {
    const { raw, keys } = await sealed(GOOD, "primary");
    expect(await verifyBundle(raw, { backup: Object.values(keys)[0] })).toBeNull();
  });

  it("accepts the backup key, which is why two are shipped", async () => {
    const { raw, keys } = await sealed(GOOD, "backup");
    expect((await verifyBundle(raw, keys))?.v).toBe(4);
  });

  it("returns null for junk rather than throwing", async () => {
    const { keys } = await sealed(GOOD);
    for (const junk of ["", "{", "null", '{"payload":"!!","sig":"!!","key":"primary"}']) {
      expect(await verifyBundle(junk, keys)).toBeNull();
    }
  });

  // A signature proves origin, not sanity. These would each leave the
  // client worse off than the list it already had.
  it("rejects a signed bundle with no usable endpoints", async () => {
    const { raw, keys } = await sealed({ ...GOOD, endpoints: [] });
    expect(await verifyBundle(raw, keys)).toBeNull();
  });

  it("drops non-https entries, and rejects the bundle if none survive", async () => {
    const mixed = { ...GOOD, endpoints: [{ kind: "panel", url: "http://plain.example/api" }] };
    const { raw, keys } = await sealed(mixed);
    expect(await verifyBundle(raw, keys)).toBeNull();
  });

  it("keeps the https entries when only some are bad", async () => {
    const mixed = {
      ...GOOD,
      endpoints: [{ kind: "panel", url: "http://plain.example/api" }, GOOD.endpoints[0]],
    };
    const { raw, keys } = await sealed(mixed);
    const out = await verifyBundle(raw, keys);
    expect(out?.endpoints).toHaveLength(1);
    expect(out?.endpoints[0].url).toBe(GOOD.endpoints[0].url);
  });
});

describe("bundle replacement", () => {
  // A genuinely-signed OLD bundle is the subtle attack: replaying it
  // walks a client back onto addresses that have since been retired.
  it("only accepts a strictly newer version", () => {
    const held = { ...GOOD, v: 4 };
    expect(isNewer({ ...GOOD, v: 5 }, held)).toBe(true);
    expect(isNewer({ ...GOOD, v: 4 }, held)).toBe(false);
    expect(isNewer({ ...GOOD, v: 3 }, held)).toBe(false);
    expect(isNewer({ ...GOOD, v: 1 }, null)).toBe(true);
  });
});

describe("ordering", () => {
  it("puts in-country entries first when a region is preferred", () => {
    const bases = orderedBases(GOOD, "ir");
    expect(bases[0]).toBe("https://node.example.net:2053/api");
  });

  it("keeps the operator's order when no region is preferred", () => {
    expect(orderedBases(GOOD)).toEqual([
      "https://panel.example.net/api",
      "https://198.51.100.10/api",
      "https://node.example.net:2053/api",
    ]);
  });

  it("de-duplicates repeated addresses", () => {
    const dupes = { ...GOOD, endpoints: [GOOD.endpoints[0], GOOD.endpoints[0]] };
    expect(orderedBases(dupes)).toHaveLength(1);
  });
});
