import { describe, expect, it } from "vitest";
import { getPublicKeyAsync, signAsync, utils } from "@noble/ed25519";
import { lastResortEntryProblem, orderedBases, verifyBundle } from "./endpoint-bundle";

/** The relay of last resort's entry kind (`kind: "lastResort"`): kept by
 * this client, apart from every list a normal request is sent to, and
 * checked by the same rules the Rust command applies to the address and
 * the pins (`parse_base`, `parse_pins` in relay_http.rs). */

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function sealed(bundle: unknown) {
  const priv = utils.randomPrivateKey();
  const pub = await getPublicKeyAsync(priv);
  const payload = new TextEncoder().encode(JSON.stringify(bundle));
  const sig = await signAsync(payload, priv);
  return {
    raw: JSON.stringify({ payload: toBase64(payload), sig: toBase64(sig), key: "primary" }),
    keys: { primary: toBase64(pub) },
  };
}

/** A pin in the one spelling every side accepts: 32 bytes, standard
 * padded base64. */
function pin(fill: number): string {
  return `sha256/${toBase64(new Uint8Array(32).fill(fill))}`;
}

const RELAY = { kind: "lastResort", url: "https://192.0.2.10/api", pins: [pin(1), pin(2)], region: "ir" };

describe("a lastResort entry", () => {
  it("is kept apart from the endpoints a normal request is sent to", async () => {
    const { raw, keys } = await sealed({
      v: 9,
      issuedAt: "2026-10-15T00:00:00Z",
      endpoints: [{ kind: "panel", url: "https://panel.example.net/api" }, RELAY],
    });
    const bundle = await verifyBundle(raw, keys);
    expect(bundle?.endpoints.map((e) => e.url)).toEqual(["https://panel.example.net/api"]);
    expect(bundle?.lastResort).toEqual([{ url: "https://192.0.2.10/api", pins: [pin(1), pin(2)], region: "ir" }]);
    // Never in the order a race or a walk is given.
    expect(orderedBases(bundle!, "ir")).toEqual(["https://panel.example.net/api"]);
  });

  it("does not make a bundle usable on its own", async () => {
    const { raw, keys } = await sealed({ v: 9, issuedAt: "2026-10-15T00:00:00Z", endpoints: [RELAY] });
    expect(await verifyBundle(raw, keys)).toBeNull();
  });

  it("is dropped, not the bundle, when it is malformed", async () => {
    const { raw, keys } = await sealed({
      v: 9,
      issuedAt: "2026-10-15T00:00:00Z",
      endpoints: [{ kind: "panel", url: "https://panel.example.net/api" }, { ...RELAY, pins: [] }],
    });
    const bundle = await verifyBundle(raw, keys);
    expect(bundle?.endpoints).toHaveLength(1);
    expect(bundle?.lastResort).toEqual([]);
  });

  it("takes a dotted IPv4 address and an optional port, and nothing else", () => {
    for (const url of ["https://192.0.2.10/api", "https://192.0.2.10:8443/api", "https://203.0.113.255/api"]) {
      expect([url, lastResortEntryProblem({ ...RELAY, url })]).toEqual([url, null]);
    }
    for (const url of [
      "http://192.0.2.10/api",
      "HTTPS://192.0.2.10/api",
      "https://192.0.2.10/api/",
      "https://192.0.2.10",
      "https://192.0.2.010/api",
      "https://3221225994/api",
      "https://0xc0.0.2.10/api",
      "https://192.0.2/api",
      "https://192.0.2.10.1/api",
      "https://256.0.2.10/api",
      "https://relay.example.net/api",
      "https://[2001:db8::1]/api",
      "https://user@192.0.2.10/api",
      "https://192.0.2.10:0/api",
      "https://192.0.2.10:65536/api",
      "https://192.0.2.10:0443/api",
      "https://192.0.2.10/api?x=1",
      "https://127.0.0.1/api",
      "https://0.0.0.0/api",
      "https://169.254.1.1/api",
      "https://224.0.0.1/api",
      "https://255.255.255.255/api",
    ]) {
      expect([url, lastResortEntryProblem({ ...RELAY, url })]).not.toEqual([url, null]);
    }
  });

  it("takes one to three distinct canonical SPKI pins", () => {
    expect(lastResortEntryProblem({ ...RELAY, pins: [pin(1)] })).toBeNull();
    expect(lastResortEntryProblem({ ...RELAY, pins: [pin(1), pin(2), pin(3)] })).toBeNull();
    for (const pins of [
      [],
      [pin(1), pin(2), pin(3), pin(4)],
      [pin(1), pin(1)],
      ["sha1/" + pin(1).slice(7)],
      [pin(1).slice(0, -1)],
      // A non-canonical spelling of the same digest: stray trailing bits.
      [pin(1).replace(/E=$/, "F=")],
      ["sha256/" + toBase64(new Uint8Array(31).fill(1))],
      [42],
      "sha256/x",
    ]) {
      expect(lastResortEntryProblem({ ...RELAY, pins })).not.toBeNull();
    }
  });

  it("refuses a single `pin`, which is a panel entry's field", () => {
    expect(lastResortEntryProblem({ ...RELAY, pin: pin(1) })).not.toBeNull();
  });
});
