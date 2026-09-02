import { BadRequestException, NotFoundException } from "@nestjs/common";
import { EndpointsService } from "./endpoints.service";

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
