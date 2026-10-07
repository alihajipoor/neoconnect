/* eslint-disable @typescript-eslint/require-await -- the service stand-ins
   match the real ones' async signatures. */
import { AdminRole } from "@prisma/client";
import type { AuthenticatedAdmin } from "../auth/types";
import { RoutesController } from "../routes/routes.controller";
import type { RoutesService } from "../routes/routes.service";
import { ProtocolConfigsController } from "./protocol-configs.controller";
import type { ProtocolConfigsService } from "./protocol-configs.service";

/** What the admin API reads back of the two secrets that live in ordinary
 * columns: OpenVPN's private keys in publicParamsJson, and a relay
 * route's uplink credential. Every staff role reads these lists, and the
 * panel passed them whole to its pages' client components. */

const openvpn = () => ({
  id: "cfg-1",
  protocol: "OPENVPN",
  publicParamsJson: {
    endpoint: "203.0.113.5:1194",
    caCertPem: "CA-CERT",
    caKeyPem: "CA-KEY",
    serverCertPem: "SERVER-CERT",
    serverKeyPem: "SERVER-KEY",
    tlsCryptKey: "TLS-CRYPT",
  },
});
const as = (role: AdminRole): AuthenticatedAdmin => ({ sub: "a", email: "a@example.com", role });

describe("GET /protocol-configs", () => {
  const service = {
    list: jest.fn(async () => [openvpn()]),
    get: jest.fn(async () => openvpn()),
    update: jest.fn(async () => openvpn()),
  };
  const controller = new ProtocolConfigsController(service as unknown as ProtocolConfigsService);

  it.each([AdminRole.SUPPORT, AdminRole.BILLING])("gives %s neither private key", async (role) => {
    for (const config of [...(await controller.list(as(role))), await controller.get(as(role), "cfg-1")]) {
      expect(config.publicParamsJson).toEqual({
        endpoint: "203.0.113.5:1194",
        caCertPem: "CA-CERT",
        serverCertPem: "SERVER-CERT",
        // Every customer receives it; and a PATCH without it would erase it.
        tlsCryptKey: "TLS-CRYPT",
      });
    }
  });

  it("gives SUPERADMIN the server key, which rebuilding a wiped node reads back, and not the CA key", async () => {
    const [listed] = await controller.list(as(AdminRole.SUPERADMIN));
    const got = await controller.get(as(AdminRole.SUPERADMIN), "cfg-1");
    for (const config of [listed, got]) {
      expect(config.publicParamsJson).toMatchObject({ serverKeyPem: "SERVER-KEY", tlsCryptKey: "TLS-CRYPT" });
      expect(config.publicParamsJson).not.toHaveProperty("caKeyPem");
    }
  });

  it("does not answer an update with the CA key either", async () => {
    const updated = await controller.update(as(AdminRole.SUPERADMIN), "cfg-1", {});
    expect(updated.publicParamsJson).not.toHaveProperty("caKeyPem");
  });

  it("leaves a config with no private keys as it was", async () => {
    const reality = { id: "cfg-2", publicParamsJson: { realityPublicKey: "pub", shortIds: ["ab"] } };
    service.list.mockResolvedValueOnce([reality as never]);
    expect(await controller.list(as(AdminRole.SUPPORT))).toEqual([reality]);
  });
});

describe("GET /routes", () => {
  const relay = () => ({ id: "route-1", name: "Iran relay", uplinkCredentialsJson: '{"uuid":"secret"}' });
  const service = {
    list: jest.fn(async () => [relay()]),
    get: jest.fn(async () => relay()),
    create: jest.fn(async () => relay()),
  };
  const controller = new RoutesController(service as unknown as RoutesService);

  it("never carries the relay's uplink credential", async () => {
    expect(await controller.list()).toEqual([{ id: "route-1", name: "Iran relay" }]);
    expect(await controller.get("route-1")).toEqual({ id: "route-1", name: "Iran relay" });
    // The installer reads only the id from a create.
    expect(await controller.create({} as never)).toEqual({ id: "route-1", name: "Iran relay" });
  });
});
