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

/** A list signed by a server key, with the statement a compiled-in key
 * (`rootId`) signs to vouch for it. Each override replaces one field of
 * the statement before it is signed, to forge one thing at a time. */
async function delegated(
  bundle: unknown,
  options: { rootId?: string; serverId?: string; expires?: number; statement?: Record<string, unknown> } = {},
) {
  const rootId = options.rootId ?? "primary";
  const serverId = options.serverId ?? "server-1";
  const rootPriv = utils.randomPrivateKey();
  const rootPub = await getPublicKeyAsync(rootPriv);
  const serverPriv = utils.randomPrivateKey();
  const serverPub = await getPublicKeyAsync(serverPriv);
  const statement = {
    kind: "neoxify-bundle-key",
    id: serverId,
    publicKey: toBase64(serverPub),
    expires: options.expires ?? Date.UTC(2027, 0, 1) / 1000,
    ...options.statement,
  };
  const statementBytes = new TextEncoder().encode(JSON.stringify(statement));
  const payload = new TextEncoder().encode(JSON.stringify(bundle));
  const envelope = {
    payload: toBase64(payload),
    sig: toBase64(await signAsync(payload, serverPriv)),
    key: serverId,
    cert: { payload: toBase64(statementBytes), sig: toBase64(await signAsync(statementBytes, rootPriv)), key: rootId },
  };
  return { envelope, keys: { [rootId]: toBase64(rootPub) }, serverPriv, rootPriv };
}

const NOW = Date.UTC(2026, 9, 18);

describe("lists signed by a server key", () => {
  it("accepts one a compiled-in key vouches for", async () => {
    const { envelope, keys } = await delegated(GOOD);
    expect((await verifyBundle(JSON.stringify(envelope), keys, NOW))?.endpoints).toHaveLength(3);
  });

  it("accepts the backup key's word as well as the primary's", async () => {
    const { envelope, keys } = await delegated(GOOD, { rootId: "backup" });
    expect((await verifyBundle(JSON.stringify(envelope), keys, NOW))?.v).toBe(4);
  });

  // The statement is what limits a stolen server key to a window.
  it("refuses one whose statement has expired", async () => {
    const { envelope, keys } = await delegated(GOOD, { expires: NOW / 1000 });
    expect(await verifyBundle(JSON.stringify(envelope), keys, NOW)).toBeNull();
    expect(await verifyBundle(JSON.stringify(envelope), keys, NOW - 1000)).not.toBeNull();
  });

  it("refuses one whose statement no compiled-in key signed", async () => {
    const { envelope } = await delegated(GOOD);
    const other = await delegated(GOOD);
    expect(await verifyBundle(JSON.stringify(envelope), other.keys, NOW)).toBeNull();
  });

  // Otherwise one leaked server key could vouch for the next.
  it("refuses a statement signed by a server key rather than a compiled-in one", async () => {
    const { envelope, keys } = await delegated(GOOD);
    const forged = { ...envelope, cert: { ...envelope.cert, key: "server-1" } };
    expect(await verifyBundle(JSON.stringify(forged), { ...keys, "server-1": keys.primary }, NOW)).toBeNull();
  });

  it("refuses one whose list was altered after the server signed it", async () => {
    const { envelope, keys } = await delegated(GOOD);
    const forged = { ...GOOD, endpoints: [{ kind: "panel", url: "https://attacker.example/api" }] };
    const altered = { ...envelope, payload: toBase64(new TextEncoder().encode(JSON.stringify(forged))) };
    expect(await verifyBundle(JSON.stringify(altered), keys, NOW)).toBeNull();
  });

  it("refuses a statement altered after the compiled-in key signed it", async () => {
    const { envelope, keys } = await delegated(GOOD);
    const statement = JSON.parse(atob(envelope.cert.payload));
    statement.expires = Date.UTC(2099, 0, 1) / 1000;
    const altered = { ...envelope, cert: { ...envelope.cert, payload: btoa(JSON.stringify(statement)) } };
    expect(await verifyBundle(JSON.stringify(altered), keys, NOW)).toBeNull();
  });

  it("refuses a statement for a different key than the one that signed", async () => {
    const { envelope, keys } = await delegated(GOOD, { statement: { id: "server-2" } });
    expect(await verifyBundle(JSON.stringify(envelope), keys, NOW)).toBeNull();
  });

  it("refuses a statement of any other kind", async () => {
    const { envelope, keys } = await delegated(GOOD, { statement: { kind: "something-else" } });
    expect(await verifyBundle(JSON.stringify(envelope), keys, NOW)).toBeNull();
  });

  // A server key may not take a compiled-in key's name: the envelope is
  // then checked against the compiled-in key, which did not sign it.
  it("refuses a server key that calls itself by a compiled-in key's name", async () => {
    const { envelope, keys } = await delegated(GOOD, { serverId: "primary", rootId: "backup" });
    const both = { ...keys, primary: keys.backup };
    expect(await verifyBundle(JSON.stringify(envelope), both, NOW)).toBeNull();
  });

  it("refuses a statement whose public key is not 32 bytes", async () => {
    const { envelope, keys } = await delegated(GOOD, { statement: { publicKey: btoa("short") } });
    expect(await verifyBundle(JSON.stringify(envelope), keys, NOW)).toBeNull();
  });

  it("ignores a statement on a list a compiled-in key signed itself", async () => {
    const { raw, keys } = await sealed(GOOD);
    const withCert = { ...JSON.parse(raw), cert: { payload: "!!", sig: "!!", key: "nobody" } };
    expect((await verifyBundle(JSON.stringify(withCert), keys, NOW))?.v).toBe(4);
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
