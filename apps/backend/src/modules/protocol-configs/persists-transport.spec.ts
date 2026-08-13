import { ProtocolConfigsService } from "./protocol-configs.service";

/**
 * create() must persist transport and security, not just validate them.
 *
 * It computed `transport` for the duplicate check and then left both
 * fields out of the written row, so every config took the schema
 * defaults. Two live failures came from that on 2026-08-13:
 *
 *  - VLESS+TLS and its WebSocket twin share a port on purpose and differ
 *    only by transport. Both stored as TCP, so the second collided with
 *    the first on the unique constraint and surfaced as a raw 500.
 *  - A REALITY config was stored as security NONE. That describes an
 *    inbound the node is not running, and a client config built from it
 *    cannot connect -- which nothing would notice until a customer tried.
 */
describe("ProtocolConfigsService.create persists transport and security", () => {
  function serviceFor() {
    const create = jest.fn().mockImplementation(({ data }: { data: unknown }) => Promise.resolve({ id: "cfg-1", ...(data as object) }));
    const prisma = { protocolConfig: { findUnique: jest.fn().mockResolvedValue(null), create } };
    return { service: new ProtocolConfigsService(prisma as never), create };
  }

  const base = {
    nodeId: "11111111-1111-1111-1111-111111111111",
    listenPort: 443,
    publicParamsJson: { realityPublicKey: "k", shortIds: ["ab"], dest: "cloudflare.com:443", serverName: "cloudflare.com" },
  };

  it("writes REALITY rather than the NONE default", async () => {
    const { service, create } = serviceFor();
    await service.create({ ...base, protocol: "XRAY_VLESS_REALITY", transport: "TCP", security: "REALITY" } as never);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ security: "REALITY", transport: "TCP" }) }),
    );
  });

  it("writes WS, so the WebSocket twin does not collide with the TCP one", async () => {
    const { service, create } = serviceFor();
    await service.create({
      ...base,
      protocol: "XRAY_VLESS_TLS",
      listenPort: 2053,
      transport: "WS",
      security: "TLS",
      publicParamsJson: { serverName: "ir1.neoxify.site", path: "/ws" },
    } as never);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ transport: "WS", security: "TLS" }) }),
    );
  });

  it("still defaults to TCP/NONE when the caller says nothing", async () => {
    // The dullest option stays the default -- a caller that omits these
    // must not accidentally claim TLS it is not serving.
    const { service, create } = serviceFor();
    await service.create({
      ...base,
      protocol: "WIREGUARD",
      listenPort: 51820,
      publicParamsJson: { serverPublicKey: "k", endpoint: "1.2.3.4:51820", subnetCidr: "10.66.0.0/24", dns: "1.1.1.1" },
    } as never);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ transport: "TCP", security: "NONE" }) }),
    );
  });

  it("checks for a duplicate against the same transport it stores", async () => {
    // The row and the uniqueness check must never disagree about which
    // transport this is.
    const { service, create } = serviceFor();
    await service.create({ ...base, protocol: "XRAY_VLESS_TLS", listenPort: 2053, transport: "WS", security: "TLS", publicParamsJson: { serverName: "x", path: "/ws" } } as never);
    const written = create.mock.calls[0][0].data.transport;
    expect(written).toBe("WS");
  });
});
