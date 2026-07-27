import { ProtocolUsersService } from "./protocol-users.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.service";
import { encryptCredentials } from "./credentials-crypto";

/** The customer-facing response is the one place server-side secrets can
 * escape to an untrusted party, so what it does and doesn't include is
 * pinned down here rather than left to review. */
describe("ProtocolUsersService.listByCustomer", () => {
  const node = { publicIp: "203.0.113.5" };

  function serviceReturning(protocol: string, publicParamsJson: Record<string, unknown>, credentials: Record<string, string>) {
    const prisma = {
      protocolUser: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "pu-1",
            subscriptionId: "sub-1",
            routeId: "route-1",
            nodeId: "node-1",
            protocolConfigId: "pc-1",
            protocol,
            externalUserId: "ext-1",
            status: "ACTIVE",
            credentialsJson: encryptCredentials(credentials),
            createdAt: new Date(),
            updatedAt: new Date(),
            node,
            protocolConfig: { protocol, listenPort: 1194, publicParamsJson },
          },
        ]),
      },
    };
    return new ProtocolUsersService(prisma as unknown as PrismaService, {} as AgentGatewayService);
  }

  it("never hands the OpenVPN CA private key to a customer", async () => {
    // The CA signs every client certificate. A customer who obtained it
    // could issue themselves unlimited certificates, valid long after
    // their subscription ended and after their account was deleted.
    const service = serviceReturning(
      "OPENVPN",
      {
        endpoint: "203.0.113.5:1194",
        proto: "udp",
        tlsCryptKey: "-----BEGIN OpenVPN Static key V1-----\nabc\n-----END OpenVPN Static key V1-----",
        caCertPem: "CA-CERT",
        caKeyPem: "THE-CA-PRIVATE-KEY",
        serverKeyPem: "THE-SERVER-PRIVATE-KEY",
        serverCertPem: "SERVER-CERT",
      },
      { certPem: "C", keyPem: "K", caCertPem: "CA", endpoint: "203.0.113.5:1194", proto: "udp" },
    );

    const [item] = await service.listByCustomer("customer-1");
    const params = item.connection.publicParams;

    expect(params).not.toHaveProperty("caKeyPem");
    expect(params).not.toHaveProperty("serverKeyPem");
    expect(params).not.toHaveProperty("serverCertPem");
    expect(JSON.stringify(item)).not.toContain("THE-CA-PRIVATE-KEY");
    expect(JSON.stringify(item)).not.toContain("THE-SERVER-PRIVATE-KEY");
  });

  it("still includes what an OpenVPN client genuinely needs", async () => {
    const service = serviceReturning(
      "OPENVPN",
      { endpoint: "203.0.113.5:1194", proto: "udp", tlsCryptKey: "KEY", caKeyPem: "SECRET" },
      { certPem: "C", keyPem: "K", caCertPem: "CA", endpoint: "203.0.113.5:1194", proto: "udp" },
    );

    const [item] = await service.listByCustomer("customer-1");

    expect(item.connection.publicParams).toEqual({
      endpoint: "203.0.113.5:1194",
      proto: "udp",
      tlsCryptKey: "KEY",
    });
  });

  it("passes through the REALITY parameters an Xray client needs", async () => {
    const service = serviceReturning(
      "XRAY_VLESS_REALITY",
      {
        realityPublicKey: "PUBKEY",
        shortIds: ["0123abcd"],
        dest: "www.microsoft.com:443",
        serverName: "www.microsoft.com",
      },
      { uuid: "u", flow: "xtls-rprx-vision" },
    );

    const [item] = await service.listByCustomer("customer-1");

    expect(item.connection.publicParams).toEqual({
      realityPublicKey: "PUBKEY",
      shortIds: ["0123abcd"],
      dest: "www.microsoft.com:443",
      serverName: "www.microsoft.com",
    });
  });

  // The whitelist had no XRAY_TROJAN entry at all, so publicParams came
  // back empty and the client fell back to using the node's IP as the
  // SNI. The certificate is issued for a domain, so it never matches an
  // IP -- every Trojan connection would have died in the TLS handshake,
  // with nothing in the app pointing at a missing server-side field.
  it("passes through the certificate's domain a Trojan client must send as SNI", async () => {
    const service = serviceReturning(
      "XRAY_TROJAN",
      { serverName: "fi1.neoxify.com" },
      { password: "shared-secret" },
    );

    const [item] = await service.listByCustomer("customer-1");

    expect(item.connection.publicParams).toEqual({ serverName: "fi1.neoxify.com" });
  });

  it("drops any key not explicitly allowed, so new ones are private by default", async () => {
    const service = serviceReturning(
      "WIREGUARD",
      {
        serverPublicKey: "PUB",
        endpoint: "203.0.113.5:51820",
        subnetCidr: "10.66.0.0/24",
        somethingAddedLater: "SHOULD-NOT-LEAK",
      },
      { privateKey: "p", publicKey: "P", address: "10.66.0.2/32", allowedIPs: "0.0.0.0/0" },
    );

    const [item] = await service.listByCustomer("customer-1");

    expect(item.connection.publicParams).not.toHaveProperty("somethingAddedLater");
  });
});
