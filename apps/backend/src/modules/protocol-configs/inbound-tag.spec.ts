import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { Protocol } from "@prisma/client";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { ProtocolConfigsService } from "./protocol-configs.service";
import { PrismaService } from "../../prisma/prisma.service";
import { UpdateProtocolConfigDto } from "./dto/update-protocol-config.dto";
import { assertInboundTagUsable, defaultInboundTagFor, effectiveInboundTag } from "./inbound-tags";

/** `ProtocolConfig.inboundTag` decides which Xray listener a customer is
 * provisioned onto, and it was settable only at create time -- so
 * correcting one meant either tearing down live provisioning (delete is
 * refused while any customer or route references the config) or writing
 * the row by hand in SQL.
 *
 * The field is not cosmetic. A relayed route's Xray routing rule matches
 * on the entry inbound tag and nothing else, so two configs resolving to
 * one tag means the second's traffic silently egresses through the
 * first's exit -- provisioned, listed in the picker, leaving from the
 * wrong country, with nothing reporting it.
 *
 * The control for every case below is the same and is stated once:
 * before this change the update DTO carried only `listenPort`,
 * `publicParamsJson` and `isEnabled`, so `inboundTag` on a PATCH body
 * was stripped by the global whitelisting ValidationPipe and the value
 * never moved. Every "sets" test therefore fails against the old DTO,
 * and every "refuses" test fails against a service that accepts the
 * field without checking it -- both demonstrated by reverting each half
 * in turn, see the journal entry.
 */
describe("inboundTag through the API", () => {
  let prisma: {
    protocolConfig: { findUnique: jest.Mock; findMany: jest.Mock; create: jest.Mock; update: jest.Mock };
    protocolUser: { findMany: jest.Mock; update: jest.Mock; count: jest.Mock };
  };
  let service: ProtocolConfigsService;

  const NODE = "11111111-1111-1111-1111-111111111111";
  const REALITY_PARAMS = {
    realityPublicKey: "abc",
    shortIds: ["0123abcd"],
    dest: "cloudflare.com:443",
    serverName: "cloudflare.com",
  };

  /** The row `update()` reads before doing anything. */
  function existing(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "config-1",
      nodeId: NODE,
      protocol: Protocol.XRAY_VLESS_REALITY,
      transport: "TCP",
      listenPort: 443,
      inboundTag: null,
      publicParamsJson: REALITY_PARAMS,
      isEnabled: true,
      ...overrides,
    };
  }

  beforeEach(() => {
    prisma = {
      protocolConfig: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "config-1", ...data })),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "config-1", ...data })),
      },
      protocolUser: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    service = new ProtocolConfigsService(prisma as unknown as PrismaService);
  });

  /* ---------------------------------------------------------------- */
  /* The DTO -- the half that made this need SQL.                      */
  /* ---------------------------------------------------------------- */

  describe("UpdateProtocolConfigDto", () => {
    async function errorsFor(body: Record<string, unknown>) {
      return validate(plainToInstance(UpdateProtocolConfigDto, body));
    }

    it("survives the real pipe, which is where it used to disappear", async () => {
      // Not `validate` on its own: the reason inboundTag needed direct
      // SQL is the app-wide ValidationPipe, which runs with
      // whitelist + forbidNonWhitelisted (see main.ts). A property with
      // no validation decorator on the DTO is not merely ignored there,
      // it is rejected -- so this exact request used to come back 400
      // and there was no way to set the field through the API at all.
      //
      // Running the pipe itself is the only assertion that would have
      // failed before and passes now; a bare `validate()` call would
      // pass either way and prove nothing.
      const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
      const result = (await pipe.transform(
        { inboundTag: "vless-fr-in" },
        { type: "body", metatype: UpdateProtocolConfigDto },
      )) as UpdateProtocolConfigDto;

      expect(result.inboundTag).toBe("vless-fr-in");
    });

    it("accepts null, which is how a tag gets cleared back to the node default", async () => {
      expect(await errorsFor({ inboundTag: null })).toEqual([]);
    });

    it("rejects a tag that cannot be an Xray tag", async () => {
      // Uppercase, spaces and dots are all things an operator reasonably
      // types and Xray never accepts.
      for (const bad of ["VLESS-IN", "vless in", "vless.in", "a".repeat(65)]) {
        expect(await errorsFor({ inboundTag: bad })).not.toEqual([]);
      }
    });
  });

  /* ---------------------------------------------------------------- */
  /* What the backend can check without the node.                      */
  /* ---------------------------------------------------------------- */

  describe("validation that does not need the node", () => {
    const target = { id: "config-1", protocol: "XRAY_VLESS_REALITY", transport: "TCP" };

    it("accepts a tag nothing else on the node answers to", () => {
      expect(() =>
        assertInboundTagUsable(
          { ...target, inboundTag: "vless-fr-in" },
          [{ id: "config-2", protocol: "WIREGUARD", transport: null, inboundTag: null }],
        ),
      ).not.toThrow();
    });

    it("refuses a tag another config on the node already answers to", () => {
      expect(() =>
        assertInboundTagUsable({ ...target, inboundTag: "vless-fr-in" }, [
          { id: "config-2", protocol: "XRAY_VLESS_REALITY", transport: "TCP", inboundTag: "vless-fr-in" },
        ]),
      ).toThrow(/config-2/);
    });

    it("refuses a tag a sibling reaches through its node default, not just an explicit one", () => {
      // The case that is easy to miss: the sibling's `inboundTag` column
      // is null, so a naive uniqueness check over the column sees no
      // clash at all -- while on the node both configs land on
      // vless-in and the second one's traffic leaves through the first
      // one's exit.
      expect(() =>
        assertInboundTagUsable({ ...target, inboundTag: "vless-in" }, [
          { id: "config-2", protocol: "XRAY_VLESS_REALITY", transport: "TCP", inboundTag: null },
        ]),
      ).toThrow(/node default/);
    });

    it("refuses another protocol's default tag", () => {
      expect(() =>
        assertInboundTagUsable(
          { id: "config-1", protocol: "XRAY_TROJAN", transport: "TCP", inboundTag: "vless-in" },
          [],
        ),
      ).toThrow(/default inbound for XRAY_VLESS_REALITY/);
    });

    it("lets a config name its own default explicitly", () => {
      expect(() =>
        assertInboundTagUsable({ ...target, inboundTag: "vless-in" }, []),
      ).not.toThrow();
    });

    it("refuses the relay's tun inbound", () => {
      // Not a customer listener. A customer provisioned onto the bridge
      // has nothing to dial.
      expect(() => assertInboundTagUsable({ ...target, inboundTag: "relay-tun-in" }, [])).toThrow(/reserved/);
    });

    it("refuses the field on a protocol that has no Xray inbound", () => {
      expect(() =>
        assertInboundTagUsable(
          { id: "config-1", protocol: "WIREGUARD", transport: null, inboundTag: "wg-in" },
          [],
        ),
      ).toThrow(/means nothing for WIREGUARD/);
    });

    it("defaults match the installer's templates", () => {
      // Pinned because this table is a third copy -- RoutesService and
      // AgentGatewayService each hold one, and the two of them are being
      // edited concurrently. A divergence should be a red test, not a
      // route that silently matches the wrong inbound.
      expect(defaultInboundTagFor("XRAY_VLESS_REALITY", "TCP")).toBe("vless-in");
      expect(defaultInboundTagFor("XRAY_VLESS_TLS", "TCP")).toBe("vless-tls-in");
      expect(defaultInboundTagFor("XRAY_VLESS_TLS", "WS")).toBe("vless-ws-in");
      expect(defaultInboundTagFor("XRAY_TROJAN", "TCP")).toBe("trojan-in");
      expect(defaultInboundTagFor("SHADOWSOCKS", "TCP")).toBe("shadowsocks-in");
      // No Xray inbound at all, which is what makes the field meaningless there.
      expect(defaultInboundTagFor("WIREGUARD", null)).toBeNull();
      expect(effectiveInboundTag({ id: "x", protocol: "XRAY_TROJAN", transport: "TCP", inboundTag: "t2" })).toBe("t2");
    });
  });

  /* ---------------------------------------------------------------- */
  /* update()                                                          */
  /* ---------------------------------------------------------------- */

  describe("update()", () => {
    it("writes the new tag", async () => {
      prisma.protocolConfig.findUnique.mockResolvedValue(existing());

      await service.update("config-1", { inboundTag: "vless-fr-in" });

      expect(prisma.protocolConfig.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ inboundTag: "vless-fr-in" }) }),
      );
    });

    it("clears the tag when sent null", async () => {
      prisma.protocolConfig.findUnique.mockResolvedValue(existing({ inboundTag: "vless-fr-in" }));

      await service.update("config-1", { inboundTag: null });

      expect(prisma.protocolConfig.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ inboundTag: null }) }),
      );
    });

    it("leaves the tag alone when the field is absent", async () => {
      prisma.protocolConfig.findUnique.mockResolvedValue(existing({ inboundTag: "vless-fr-in" }));

      await service.update("config-1", { isEnabled: false });

      // Absent and null are different requests and must stay that way:
      // an edit dialog that saves a port must not silently reset the
      // inbound every existing customer is served on.
      const data = prisma.protocolConfig.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty("inboundTag");
    });

    it("refuses a tag that clashes with another config on the node", async () => {
      prisma.protocolConfig.findUnique.mockResolvedValue(existing());
      prisma.protocolConfig.findMany.mockResolvedValue([
        { id: "config-2", protocol: "XRAY_VLESS_REALITY", transport: "TCP", inboundTag: "vless-fr-in" },
      ]);

      await expect(service.update("config-1", { inboundTag: "vless-fr-in" })).rejects.toThrow(BadRequestException);
      expect(prisma.protocolConfig.update).not.toHaveBeenCalled();
    });

    it("does not treat the config's own row as a clash with itself", async () => {
      prisma.protocolConfig.findUnique.mockResolvedValue(existing());
      // findMany is every config on the node, this one included.
      prisma.protocolConfig.findMany.mockResolvedValue([
        { id: "config-1", protocol: "XRAY_VLESS_REALITY", transport: "TCP", inboundTag: null },
      ]);

      await expect(service.update("config-1", { inboundTag: "vless-fr-in" })).resolves.toBeDefined();
    });

    it("refuses to strand customers who are already provisioned", async () => {
      prisma.protocolConfig.findUnique.mockResolvedValue(existing());
      prisma.protocolUser.count.mockResolvedValue(29);

      const promise = service.update("config-1", { inboundTag: "vless-fr-in" });

      // The number is the point. "This may affect customers" is what the
      // panel already said; "29 customers" is what stops somebody.
      await expect(promise).rejects.toThrow(/29 customer/);
      expect(prisma.protocolConfig.update).not.toHaveBeenCalled();
    });

    it("allows it once the operator has acknowledged the re-provision", async () => {
      prisma.protocolConfig.findUnique.mockResolvedValue(existing());
      prisma.protocolUser.count.mockResolvedValue(29);

      await service.update("config-1", { inboundTag: "vless-fr-in", confirmReprovision: true });

      expect(prisma.protocolConfig.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ inboundTag: "vless-fr-in" }) }),
      );
    });

    it("does not ask for an acknowledgement when nothing is provisioned", async () => {
      prisma.protocolConfig.findUnique.mockResolvedValue(existing());
      prisma.protocolUser.count.mockResolvedValue(0);

      await expect(service.update("config-1", { inboundTag: "vless-fr-in" })).resolves.toBeDefined();
    });

    it("does not ask for an acknowledgement when the tag is not actually changing", async () => {
      prisma.protocolConfig.findUnique.mockResolvedValue(existing({ inboundTag: "vless-fr-in" }));
      prisma.protocolUser.count.mockResolvedValue(29);

      // Re-saving the dialog with the same value in the box is not a
      // change and must not demand a confirmation for one.
      await expect(
        service.update("config-1", { inboundTag: "vless-fr-in", isEnabled: false }),
      ).resolves.toBeDefined();
      expect(prisma.protocolUser.count).not.toHaveBeenCalled();
    });
  });

  /* ---------------------------------------------------------------- */
  /* create() -- the field was accepted here and never checked.        */
  /* ---------------------------------------------------------------- */

  describe("create()", () => {
    it("refuses a tag another config on the node already answers to", async () => {
      prisma.protocolConfig.findMany.mockResolvedValue([
        { id: "config-2", protocol: "XRAY_VLESS_REALITY", transport: "TCP", inboundTag: null },
      ]);

      const promise = service.create({
        nodeId: NODE,
        protocol: Protocol.XRAY_VLESS_REALITY,
        listenPort: 8443,
        publicParamsJson: { ...REALITY_PARAMS },
        inboundTag: "vless-in",
      });

      await expect(promise).rejects.toThrow(BadRequestException);
      expect(prisma.protocolConfig.create).not.toHaveBeenCalled();
    });

    it("still stores a tag that is genuinely free", async () => {
      await service.create({
        nodeId: NODE,
        protocol: Protocol.XRAY_VLESS_REALITY,
        listenPort: 8443,
        publicParamsJson: { ...REALITY_PARAMS },
        inboundTag: "vless-fr-in",
      });

      expect(prisma.protocolConfig.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ inboundTag: "vless-fr-in" }) }),
      );
    });
  });
});
