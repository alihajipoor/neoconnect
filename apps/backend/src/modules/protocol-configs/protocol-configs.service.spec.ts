import { BadRequestException } from "@nestjs/common";
import { Protocol } from "@prisma/client";
import { ProtocolConfigsService } from "./protocol-configs.service";
import { PrismaService } from "../../prisma/prisma.service";
import { decryptCredentials, encryptCredentials } from "../protocol-users/credentials-crypto";

/** Regression tests for the class of failure that produced three
 * unusable protocol configs in production: publicParamsJson passed
 * `@IsObject()` while being empty, and nothing complained until a
 * customer's app failed to connect. */
describe("ProtocolConfigsService", () => {
  let prisma: {
    protocolConfig: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    protocolUser: {
      findMany: jest.Mock;
      update: jest.Mock;
    };
  };
  let service: ProtocolConfigsService;

  beforeEach(() => {
    prisma = {
      protocolConfig: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "config-1", ...data })),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "config-1", ...data })),
      },
      protocolUser: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
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

  describe("update", () => {
    /** Stands in for a config already stored, as `get()` would return it. */
    function existing(overrides: Record<string, unknown> = {}) {
      prisma.protocolConfig.findUnique.mockResolvedValueOnce({
        id: "config-1",
        nodeId: base.nodeId,
        protocol: Protocol.WIREGUARD,
        listenPort: 51820,
        publicParamsJson: {
          serverPublicKey: "old-key",
          endpoint: "203.0.113.5:51820",
          subnetCidr: "10.77.0.0/24",
        },
        isEnabled: true,
        ...overrides,
      });
    }

    it("corrects publicParamsJson in place", async () => {
      // The repair path this method exists for: a config registered with
      // wrong params, still referenced by live customers so it can't be
      // deleted and recreated.
      existing();

      await service.update("config-1", {
        publicParamsJson: {
          serverPublicKey: "corrected-key",
          endpoint: "204.168.161.100:51820",
          subnetCidr: "10.66.0.0/24",
        },
      });

      const written = prisma.protocolConfig.update.mock.calls[0][0].data;
      expect(written.publicParamsJson.serverPublicKey).toBe("corrected-key");
      expect(written.publicParamsJson.subnetCidr).toBe("10.66.0.0/24");
    });

    it("still rejects an update that leaves required params missing", async () => {
      existing();

      await expect(service.update("config-1", { publicParamsJson: { endpoint: "1.2.3.4:51820" } })).rejects.toThrow(
        /serverPublicKey/,
      );
      expect(prisma.protocolConfig.update).not.toHaveBeenCalled();
    });

    it("preserves an OpenVPN CA that the update body omits", async () => {
      // Correcting an endpoint must not invalidate every client
      // certificate ever signed by this CA.
      existing({
        protocol: Protocol.OPENVPN,
        listenPort: 1194,
        publicParamsJson: {
          endpoint: "203.0.113.5:1194",
          caCertPem: "THE-CA-CERT",
          caKeyPem: "THE-CA-KEY",
          serverCertPem: "THE-SERVER-CERT",
          serverKeyPem: "THE-SERVER-KEY",
        },
      });

      await service.update("config-1", { publicParamsJson: { endpoint: "204.168.161.100:1194", proto: "udp" } });

      const written = prisma.protocolConfig.update.mock.calls[0][0].data;
      expect(written.publicParamsJson.endpoint).toBe("204.168.161.100:1194");
      expect(written.publicParamsJson.caCertPem).toBe("THE-CA-CERT");
      expect(written.publicParamsJson.caKeyPem).toBe("THE-CA-KEY");
      expect(written.publicParamsJson.serverCertPem).toBe("THE-SERVER-CERT");
    });

    it("refuses to let a caller replace the CA even explicitly", async () => {
      existing({
        protocol: Protocol.OPENVPN,
        listenPort: 1194,
        publicParamsJson: { endpoint: "203.0.113.5:1194", caCertPem: "THE-CA-CERT", caKeyPem: "THE-CA-KEY" },
      });

      await service.update("config-1", {
        publicParamsJson: { endpoint: "203.0.113.5:1194", caCertPem: "ATTACKER-CA", caKeyPem: "ATTACKER-KEY" },
      });

      const written = prisma.protocolConfig.update.mock.calls[0][0].data;
      expect(written.publicParamsJson.caCertPem).toBe("THE-CA-CERT");
      expect(written.publicParamsJson.caKeyPem).toBe("THE-CA-KEY");
    });

    it("leaves publicParamsJson untouched when the update doesn't mention it", async () => {
      existing();

      await service.update("config-1", { isEnabled: false });

      const written = prisma.protocolConfig.update.mock.calls[0][0].data;
      expect(written.isEnabled).toBe(false);
      expect(written.publicParamsJson).toBeUndefined();
    });

    it("rejects a port already used by another config on the same node", async () => {
      existing();
      prisma.protocolConfig.findUnique.mockResolvedValueOnce({ id: "other-config" });

      await expect(service.update("config-1", { listenPort: 51821 })).rejects.toThrow(/already uses port/);
    });

    // Moving a port used to do exactly half a migration: the row said
    // the new port, the node listened on the new port, and every
    // customer already provisioned went on dialling the old one,
    // because WireGuard and OpenVPN credentials are whole config files
    // with the endpoint baked in at generation. Nothing reported it --
    // from the panel the change had succeeded.
    it("carries a new endpoint into credentials that were already issued", async () => {
      existing();
      prisma.protocolUser.findMany.mockResolvedValueOnce([
        { id: "user-1", credentialsJson: encryptCredentials({ privateKey: "k", endpoint: "203.0.113.5:51820" }) },
      ]);

      await service.update("config-1", {
        listenPort: 41820,
        publicParamsJson: {
          serverPublicKey: "old-key",
          endpoint: "203.0.113.5:41820",
          subnetCidr: "10.77.0.0/24",
        },
      });

      expect(prisma.protocolUser.update).toHaveBeenCalledTimes(1);
      const written = prisma.protocolUser.update.mock.calls[0][0].data;
      const credentials = decryptCredentials(written.credentialsJson);
      expect(credentials.endpoint).toBe("203.0.113.5:41820");
      // The key is untouched: a port change must not hand out a new
      // one, which would consume another pool address and drop anyone
      // currently connected.
      expect(credentials.privateKey).toBe("k");
    });

    it("leaves Xray credentials alone, since they carry no endpoint", async () => {
      existing({
        protocol: Protocol.XRAY_TROJAN,
        publicParamsJson: { serverName: "fi1.neoxify.site" },
      });

      await service.update("config-1", { listenPort: 8444 });

      expect(prisma.protocolUser.findMany).not.toHaveBeenCalled();
    });
  });
});
