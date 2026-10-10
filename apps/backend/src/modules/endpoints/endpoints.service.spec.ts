import { BadRequestException, Logger, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { EndpointsService } from "./endpoints.service";

// Skipped entries are warned about, which is for an operator's log and
// only noise here.
beforeAll(() => {
  jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});

/** A well-formed SPKI pin that pins nothing real: the SHA-256 of a label. */
function fakePin(label: string): string {
  return `sha256/${createHash("sha256").update(label).digest("base64")}`;
}

// RFC 5737 documentation addresses only, never a real one.
const RELAY_URL = "https://192.0.2.10/api";
const PIN_A = fakePin("relay");
const PIN_B = fakePin("standby");

function relay(overrides: Record<string, unknown> = {}) {
  return { kind: "lastResort", url: RELAY_URL, pins: [PIN_A, PIN_B], ...overrides };
}

/** The host of an entry's URL as a client would connect to it. */
function hostOf(url: string): string {
  return new URL(url).hostname;
}
const IP_HOST = /^(\d+\.\d+\.\d+\.\d+|\[.*\])$/;

function seal(bundle: unknown): string {
  // Only the envelope shape matters here: publish() deliberately does not
  // verify signatures -- the panel has no key and the client is the only
  // place a check counts.
  return JSON.stringify({
    payload: Buffer.from(JSON.stringify(bundle)).toString("base64"),
    sig: "not-checked-here",
    key: "primary",
  });
}

function build(state: Record<string, unknown> = {}, nodes: unknown[] = []) {
  const row = { id: "s1", panelBasesJson: "[]", signed: null, version: 0, ...state };
  const updates: Record<string, unknown>[] = [];
  const prisma = {
    endpointBundleState: {
      findFirst: jest.fn().mockResolvedValue(row),
      create: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return Promise.resolve({ ...row, ...data });
      }),
    },
    node: { findMany: jest.fn().mockResolvedValue(nodes) },
  };
  return { service: new EndpointsService(prisma as never), updates, prisma };
}

describe("EndpointsService draft", () => {
  it("derives a mirror per ONLINE node, addressed by IP", async () => {
    const { service, prisma } = build({}, [
      { name: "finland1", region: "fi-finland", mirrorHost: "aaa111.example.net" },
      { name: "ir1", region: "ir-iran", mirrorHost: "bbb222.example.net" },
    ]);

    const draft = await service.draft();

    expect(prisma.node.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "ONLINE", mirrorHost: { not: null } } }),
    );
    expect(draft.endpoints).toEqual([
      { kind: "mirror", url: "https://aaa111.example.net:2053/api", region: "fi" },
      { kind: "mirror", url: "https://bbb222.example.net:2053/api", region: "ir" },
    ]);
  });

  it("puts configured panel bases before the derived mirrors", async () => {
    const { service } = build(
      { panelBasesJson: JSON.stringify([{ url: "https://panel.example.net/api" }]) },
      [{ name: "finland1", region: "fi-finland", mirrorHost: "aaa111.example.net" }],
    );
    const draft = await service.draft();
    expect(draft.endpoints[0]).toEqual({
      kind: "panel",
      url: "https://panel.example.net/api",
      pin: undefined,
      region: undefined,
    });
    expect(draft.endpoints[1].kind).toBe("mirror");
  });

  // The mirrors are what keep censored customers working. A typo in a
  // setting must not be able to take them out of the draft.
  it("still emits mirrors when the configured bases are malformed", async () => {
    const { service } = build({ panelBasesJson: "{not json" }, [
      { name: "finland1", region: "fi-finland", mirrorHost: "aaa111.example.net" },
    ]);
    const draft = await service.draft();
    expect(draft.endpoints).toHaveLength(1);
    expect(draft.endpoints[0].kind).toBe("mirror");
  });

  it("drops a non-https configured base", async () => {
    const { service } = build({
      panelBasesJson: JSON.stringify([{ url: "http://plain.example/api" }]),
    });
    expect((await service.draft()).endpoints).toHaveLength(0);
  });

  it("proposes the next version, so a signed draft is always newer", async () => {
    const { service } = build({ version: 6 });
    expect((await service.draft()).v).toBe(7);
  });
});

describe("EndpointsService publish", () => {
  it("stores the envelope verbatim", async () => {
    const { service, updates } = build({ version: 1 });
    const signed = seal({ v: 2, issuedAt: "x", endpoints: [{ kind: "panel", url: "https://a/api" }] });

    await service.publish(signed);

    expect(updates[0].signed).toBe(signed);
    expect(updates[0].version).toBe(2);
  });

  // A version clients will not accept is a rollout that silently did not
  // happen, which is worse than an error.
  it("refuses a version that is not strictly newer", async () => {
    const { service } = build({ version: 5 });
    const same = seal({ v: 5, issuedAt: "x", endpoints: [{ kind: "panel", url: "https://a/api" }] });
    await expect(service.publish(same)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a bundle with no endpoints", async () => {
    const { service } = build();
    await expect(service.publish(seal({ v: 9, endpoints: [] }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("refuses junk rather than storing it", async () => {
    const { service } = build();
    for (const junk of ["", "{", '{"payload":"###"}']) {
      await expect(service.publish(junk)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});

describe("EndpointsService published", () => {
  // "Nothing published" and "a bundle saying go nowhere" must not look
  // the same: the second would overwrite a good cached list.
  it("404s before anything has been published", async () => {
    const { service } = build({ signed: null });
    await expect(service.published()).rejects.toBeInstanceOf(NotFoundException);
  });

  it("returns exactly the bytes that were stored", async () => {
    const signed = seal({ v: 3, endpoints: [{ kind: "panel", url: "https://a/api" }] });
    const { service } = build({ signed });
    expect(await service.published()).toBe(signed);
  });
});

describe("EndpointsService mirror addressing", () => {
  // The defect the first version shipped: mirrors addressed by IP, and a
  // client that verifies certificates rejects every one of them, because
  // the node's certificate is for a name and not an address. Testing with
  // `curl -k` hid it.
  it("asks only for nodes that have a mirror hostname", async () => {
    const { service, prisma } = build({}, []);
    await service.draft();
    expect(prisma.node.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: "ONLINE", mirrorHost: { not: null } } }),
    );
  });

  it("never emits an IP-addressed mirror", async () => {
    const { service } = build({}, [
      { name: "finland1", region: "fi-finland", mirrorHost: "aaa111.example.net" },
    ]);
    const draft = await service.draft();
    for (const e of draft.endpoints) {
      expect(e.url).not.toMatch(/https:\/\/\d+\.\d+\.\d+\.\d+/);
    }
  });
});

describe("EndpointsService lastResort in the draft", () => {
  it("keeps the lastResort kind and pins, and puts it after every mirror", async () => {
    const { service } = build(
      {
        // Stored first, to show the draft moves it rather than keeping
        // the stored order.
        panelBasesJson: JSON.stringify([relay({ region: "ir" }), { url: "https://panel.example.com/api" }]),
      },
      [{ name: "finland1", region: "fi-finland", mirrorHost: "aaa111.example.net" }],
    );

    const draft = await service.draft();

    expect(draft.endpoints.map((e) => e.kind)).toEqual(["panel", "mirror", "lastResort"]);
    expect(draft.endpoints[2]).toEqual({
      kind: "lastResort",
      url: RELAY_URL,
      pins: [PIN_A, PIN_B],
      region: "ir",
    });
  });

  // The property shipped clients depend on: they keep only panel and
  // mirror, so the relay is invisible to them only while it never wears
  // either kind.
  it("never emits the relay's address as a panel or a mirror", async () => {
    const { service } = build(
      { panelBasesJson: JSON.stringify([relay(), { url: "https://panel.example.com/api" }]) },
      [{ name: "finland1", region: "fi-finland", mirrorHost: "aaa111.example.net" }],
    );

    const draft = await service.draft();

    for (const e of draft.endpoints) {
      if (e.kind === "panel" || e.kind === "mirror") expect(hostOf(e.url)).not.toMatch(IP_HOST);
    }
    expect(draft.endpoints.filter((e) => e.url === RELAY_URL).map((e) => e.kind)).toEqual(["lastResort"]);
  });

  it("drafts a stored entry without kind as a panel, as before", async () => {
    const { service } = build({
      panelBasesJson: JSON.stringify([{ url: "https://panel.example.com/api", pin: "pin-x", region: "de" }]),
    });
    expect((await service.draft()).endpoints).toEqual([
      { kind: "panel", url: "https://panel.example.com/api", pin: "pin-x", region: "de" },
    ]);
  });

  // The previous write path accepted any https URL, so an address may
  // already be stored. It must not reach a bundle as a panel.
  it("skips a stored panel base addressed by IP, in any spelling", async () => {
    const { service } = build({
      panelBasesJson: JSON.stringify([
        { url: "https://198.51.100.7/api" },
        { url: "https://198.51.100.7:8443/api" },
        // 192.0.2.1 written as one decimal number, which the URL parser
        // reads as an address.
        { url: "https://3221225985/api" },
        { url: "https://[2001:db8::1]/api" },
        { url: "https://panel.example.com/api" },
      ]),
    });
    expect((await service.draft()).endpoints).toEqual([
      expect.objectContaining({ kind: "panel", url: "https://panel.example.com/api" }),
    ]);
  });

  it("skips a stored entry that breaks the rules rather than emitting it as anything", async () => {
    const { service } = build({
      panelBasesJson: JSON.stringify([
        relay({ pins: [] }),
        relay({ url: "https://relay.example.com/api" }),
        { kind: "mirror", url: "https://mirror.example.com:2053/api" },
        { kind: "somethingElse", url: "https://other.example.com/api" },
      ]),
    });
    expect((await service.draft()).endpoints).toEqual([]);
  });
});

describe("EndpointsService mirror guard", () => {
  // mirrorHost is free text in the nodes table. An address typed there
  // must cost that node its mirror, not every other node theirs.
  it("skips a mirror whose mirrorHost is an IP address and keeps the rest", async () => {
    const { service } = build({}, [
      { name: "v4", region: "fi-finland", mirrorHost: "203.0.113.5" },
      { name: "decimal", region: "fi-finland", mirrorHost: "3221225985" },
      { name: "v6", region: "fi-finland", mirrorHost: "2001:db8::5" },
      { name: "v6-bracketed", region: "fi-finland", mirrorHost: "[2001:db8::6]" },
      { name: "named", region: "fi-finland", mirrorHost: "aaa111.example.net" },
    ]);

    const draft = await service.draft();

    expect(draft.endpoints).toEqual([
      { kind: "mirror", url: "https://aaa111.example.net:2053/api", region: "fi" },
    ]);
  });
});

describe("EndpointsService setPanelBases", () => {
  it("stores panel and lastResort entries in normalised form", async () => {
    const { service, updates } = build();

    await service.setPanelBases([
      { url: "https://panel.example.com/api", region: "de" },
      relay({ region: "ir", note: "stray fields are not stored" }),
    ]);

    expect(JSON.parse(updates[0].panelBasesJson as string)).toEqual([
      { kind: "panel", url: "https://panel.example.com/api", region: "de" },
      { kind: "lastResort", url: RELAY_URL, pins: [PIN_A, PIN_B], region: "ir" },
    ]);
  });

  it("still accepts the body shape from before lastResort, without kind", async () => {
    const { service, updates } = build();
    await service.setPanelBases([{ url: "https://panel.example.com/api", pin: "pin-x" }]);
    expect(JSON.parse(updates[0].panelBasesJson as string)).toEqual([
      { kind: "panel", url: "https://panel.example.com/api", pin: "pin-x" },
    ]);
  });

  it("accepts a relay on an explicit port", async () => {
    const { service, updates } = build();
    await service.setPanelBases([relay({ url: "https://192.0.2.10:8443/api", pins: [PIN_A] })]);
    expect(JSON.parse(updates[0].panelBasesJson as string)).toEqual([
      { kind: "lastResort", url: "https://192.0.2.10:8443/api", pins: [PIN_A] },
    ]);
  });

  it.each([
    "https://192.0.2.1/api",
    "https://198.51.100.7:8443/api",
    "https://3221225985/api",
    "https://0xc0.0.2.1/api",
    "https://[2001:db8::1]/api",
  ])("refuses a panel base addressed by IP (%s), saying why", async (url) => {
    const { service, updates } = build();
    await expect(service.setPanelBases([{ url }])).rejects.toThrow(
      /^entries\[0\]: url must name a DNS host, not an IP address/,
    );
    await expect(service.setPanelBases([{ kind: "panel", url }])).rejects.toBeInstanceOf(BadRequestException);
    expect(updates).toHaveLength(0);
  });

  it("refuses a panel base that is not https", async () => {
    const { service } = build();
    await expect(service.setPanelBases([{ url: "http://panel.example.com/api" }])).rejects.toThrow(
      "entries[0]: url must be https",
    );
  });

  it("refuses a configured mirror, since mirrors are derived", async () => {
    const { service } = build();
    await expect(
      service.setPanelBases([{ kind: "mirror", url: "https://mirror.example.com:2053/api" }]),
    ).rejects.toThrow(/mirrors are derived/);
  });

  it("refuses an unknown kind", async () => {
    const { service } = build();
    await expect(
      service.setPanelBases([{ kind: "relay", url: "https://panel.example.com/api" }]),
    ).rejects.toThrow('entries[0]: kind must be "panel" or "lastResort", not "relay"');
  });

  it("refuses a body that is not a list", async () => {
    const { service } = build();
    await expect(service.setPanelBases({ url: "https://panel.example.com/api" })).rejects.toThrow(
      "entries must be a list",
    );
  });

  // A partial save would leave the operator believing an entry is listed
  // when it is not.
  it("refuses the whole list on one bad entry and stores nothing", async () => {
    const { service, updates } = build();
    await expect(
      service.setPanelBases([{ url: "https://panel.example.com/api" }, relay({ pins: [] })]),
    ).rejects.toThrow(/^entries\[1\]: /);
    expect(updates).toHaveLength(0);
  });

  /** The same 32 bytes with one of the unused trailing bits set: valid
   * base64 that decodes identically, in a spelling no client computes. */
  function nonCanonical(pin: string): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const chars = pin.split("");
    const last = chars.length - 2; // the character before the "=" pad
    chars[last] = alphabet[alphabet.indexOf(chars[last]) ^ 1];
    return chars.join("");
  }

  it.each<[string, Record<string, unknown>, RegExp]>([
    ["no pins at all", { pins: undefined }, /pins must be a list/],
    ["pins that are not a list", { pins: PIN_A }, /pins must be a list/],
    ["zero pins", { pins: [] }, /pins must hold 1 to 3 entries, not 0/],
    [
      "more than three pins",
      { pins: [fakePin("1"), fakePin("2"), fakePin("3"), fakePin("4")] },
      /pins must hold 1 to 3 entries, not 4/,
    ],
    ["a pin with the wrong prefix", { pins: [PIN_A.replace("sha256/", "sha1/")] }, /pins\[0\] must start with "sha256\/"/],
    ["a pin with an upper-case prefix", { pins: [PIN_A.replace("sha256/", "SHA256/")] }, /must start with "sha256\/"/],
    ["a bare base64 digest", { pins: [PIN_A.slice("sha256/".length)] }, /must start with "sha256\/"/],
    ["a pin one character short", { pins: [PIN_A.slice(0, -1)] }, /exactly 44 base64 characters.*not 43/],
    [
      "a SHA-512 length pin",
      { pins: [`sha256/${createHash("sha512").update("x").digest("base64")}`] },
      /exactly 44 base64 characters.*not 88/,
    ],
    [
      "a pin with a non-base64 character",
      { pins: [`${PIN_A.slice(0, 10)}!${PIN_A.slice(11)}`] },
      /is not standard base64/,
    ],
    [
      "a base64url pin",
      { pins: [`sha256/${createHash("sha256").update("x").digest("base64url")}=`] },
      /is not standard base64/,
    ],
    ["a pin decoding to 33 bytes", { pins: [`sha256/${"A".repeat(44)}`] }, /must decode to 32 bytes.*not 33/],
    ["a non-canonical pin", { pins: [nonCanonical(PIN_A)] }, /not the canonical base64/],
    ["a pin that is not a string", { pins: [42] }, /pins\[0\] must be a string/],
    ["a repeated pin", { pins: [PIN_A, PIN_A] }, /pins must be distinct/],
    ["the singular pin field", { pin: PIN_A }, /takes pins \(a list\), not pin/],
    ["a bad pin after a good one", { pins: [PIN_A, "sha256/short"] }, /pins\[1\] /],
  ])("refuses a lastResort entry with %s", async (_name, overrides, reason) => {
    const { service, updates } = build();
    await expect(service.setPanelBases([relay(overrides)])).rejects.toThrow(BadRequestException);
    await expect(service.setPanelBases([relay(overrides)])).rejects.toThrow(reason);
    expect(updates).toHaveLength(0);
  });

  it.each<[string, string, RegExp]>([
    ["http", "http://192.0.2.10/api", /url must be https/],
    ["userinfo", "https://user:secret@192.0.2.10/api", /must not carry userinfo/],
    ["a user without a password", "https://user@192.0.2.10/api", /must not carry userinfo/],
    ["a query", "https://192.0.2.10/api?x=1", /must not carry a query/],
    ["an empty query", "https://192.0.2.10/api?", /must not carry a query/],
    ["a fragment", "https://192.0.2.10/api#x", /must not carry a fragment/],
    ["a DNS name", "https://relay.example.com/api", /host must be an IPv4 address/],
    ["an IPv6 address", "https://[2001:db8::1]/api", /host must be an IPv4 address/],
    ["the root path", "https://192.0.2.10/", /path must be \/api/],
    ["a trailing slash", "https://192.0.2.10/api/", /path must be \/api/],
    ["another path", "https://192.0.2.10/v2/api", /path must be \/api/],
    ["a decimal address", "https://3221225994/api", /must be written as https:\/\/192\.0\.2\.10\/api/],
    ["a leading zero", "https://192.0.2.010/api", /must be written as https:\/\/192\.0\.2\.8\/api/],
    ["an explicit :443", "https://192.0.2.10:443/api", /must be written as https:\/\/192\.0\.2\.10\/api/],
    ["an empty userinfo", "https://@192.0.2.10/api", /must be written as https:\/\/192\.0\.2\.10\/api/],
    ["no host", "https://", /not a valid URL/],
  ])("refuses a lastResort url with %s", async (_name, url, reason) => {
    const { service, updates } = build();
    await expect(service.setPanelBases([relay({ url })])).rejects.toThrow(reason);
    expect(updates).toHaveLength(0);
  });
});
