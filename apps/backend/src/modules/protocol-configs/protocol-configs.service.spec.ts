import { BadRequestException } from "@nestjs/common";
import { Protocol } from "@prisma/client";
import { ProtocolConfigsService } from "./protocol-configs.service";
import { PrismaService } from "../../prisma/prisma.service";

/** Regression tests for the class of failure that produced three
 * unusable protocol configs in production: publicParamsJson passed
 * `@IsObject()` while being empty, and nothing complained until a
 * customer's app failed to connect. */
describe("ProtocolConfigsService", () => {
  let prisma: {
    protocolConfig: {
      findUnique: jest.Mock;
      create: jest.Mock;
    };
  };
  let service: ProtocolConfigsService;

  beforeEach(() => {
    prisma = {
      protocolConfig: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "config-1", ...data })),
      },
    };
    service = new ProtocolConfigsService(prisma as unknown as PrismaService);
  });

  const base = { nodeId: "11111111-1111-1111-1111-111111111111", listenPort: 443 };

  describe("publicParamsJson validation", () => {
    it("rejects a WireGuard config with empty params, naming every missing key", async () => {
      const promise = service.create({ ...base, protocol: Protocol.WIREGUARD, publicParamsJson: {} });

      await expect(promise).rejects.toThrow(BadRequestException);
      await expect(promise).rejects.toThrow(/serverPublicKey/);
      await expect(promise).rejects.toThrow(/endpoint/);
      await expect(promise).rejects.toThrow(/subnetCidr/);
      expect(prisma.protocolConfig.create).not.toHaveBeenCalled();
    });

    it("rejects a REALITY config whose shortIds is an empty array", async () => {
      // An empty array is as unusable to a client as an absent key, but
      // is truthy and would slip past a plain presence check.
      const promise = service.create({
        ...base,
        protocol: Protocol.XRAY_VLESS_REALITY,
        publicParamsJson: {
          realityPublicKey: "abc",
          shortIds: [],
          dest: "www.microsoft.com:443",
          serverName: "www.microsoft.com",
        },
      });

      await expect(promise).rejects.toThrow(/shortIds/);
      expect(prisma.protocolConfig.create).not.toHaveBeenCalled();
    });

    it("rejects a config whose required value is an empty string", async () => {
      const promise = service.create({
        ...base,
        protocol: Protocol.WIREGUARD,
        publicParamsJson: { serverPublicKey: "", endpoint: "1.2.3.4:51820", subnetCidr: "10.77.0.0/24" },
      });

      await expect(promise).rejects.toThrow(/serverPublicKey/);
    });

    it("accepts a complete WireGuard config", async () => {
      await service.create({
        ...base,
        protocol: Protocol.WIREGUARD,
        publicParamsJson: {
          serverPublicKey: "1AafKzvRrvjXvsKSmx4IQTw/BiLF/iMJ2sIBZHP4qAE=",
          endpoint: "203.0.113.5:51820",
          subnetCidr: "10.77.0.0/24",
        },
      });

      expect(prisma.protocolConfig.create).toHaveBeenCalled();
    });

    it("accepts an OpenVPN config with only an endpoint, since the CA is generated here", async () => {
      await service.create({
        ...base,
        protocol: Protocol.OPENVPN,
        publicParamsJson: { endpoint: "203.0.113.5:1194" },
      });

      const created = prisma.protocolConfig.create.mock.calls[0][0].data;
      expect(created.publicParamsJson.caCertPem).toContain("BEGIN CERTIFICATE");
      expect(created.publicParamsJson.caKeyPem).toBeDefined();
    });

    it("still rejects an OpenVPN config with no endpoint", async () => {
      // The CA is generated, but where to connect can only come from the
      // admin -- and generating a CA for a config that is then rejected
      // would be wasted work, so validation runs first.
      const promise = service.create({ ...base, protocol: Protocol.OPENVPN, publicParamsJson: {} });

      await expect(promise).rejects.toThrow(/endpoint/);
      expect(prisma.protocolConfig.create).not.toHaveBeenCalled();
    });
  });
});
