import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { CustomerJwtAuthGuard } from "../../common/guards/customer-jwt-auth.guard";
import { THROTTLE_VOLUME_PER_SESSION } from "../../common/guards/client-throttler.guard";
import { CustomerDiagnosticsController } from "./customer-diagnostics.controller";
import type { ClientAttemptsService } from "./client-attempts.service";

const handler = (name: string) => (CustomerDiagnosticsController.prototype as unknown as Record<string, object>)[name];

describe("CustomerDiagnosticsController", () => {
  it("is behind the customer guard", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, CustomerDiagnosticsController)).toContain(CustomerJwtAuthGuard);
  });

  /** "THROTTLER:LIMIT"/"THROTTLER:TTL" + throttler name: the keys
   * @nestjs/throttler stores a route's own limit under, which
   * client-throttler.guard.ts reads. */
  it("lets one session send six bundles an hour", () => {
    const send = handler("send");
    expect(Reflect.getMetadata("THROTTLER:LIMITdefault", send)).toBe(6);
    expect(Reflect.getMetadata("THROTTLER:TTLdefault", send)).toBe(3_600_000);
    expect(Reflect.getMetadata(THROTTLE_VOLUME_PER_SESSION, send)).toBe(true);
  });

  it("files the bundle under the caller and the session of its token", async () => {
    const recordDiagnostics = jest.fn().mockResolvedValue({ id: "abcdef12-0000", reference: "abcdef12" });
    const controller = new CustomerDiagnosticsController({ recordDiagnostics } as unknown as ClientAttemptsService);
    const dto = { platform: "linux", appVersion: "0.2.1" };
    await expect(controller.send({ sub: "cust-1", email: "c@example.com", sid: "s1" }, dto)).resolves.toEqual({
      id: "abcdef12-0000",
      reference: "abcdef12",
    });
    expect(recordDiagnostics).toHaveBeenCalledWith(dto, { customerId: "cust-1", sessionId: "s1" });
  });

  describe("targets", () => {
    const saved = process.env.SERVICE_CHECKS;
    afterEach(() => {
      if (saved === undefined) delete process.env.SERVICE_CHECKS;
      else process.env.SERVICE_CHECKS = saved;
    });
    const controller = new CustomerDiagnosticsController({} as ClientAttemptsService);

    it("is on by default and off with SERVICE_CHECKS=off", () => {
      delete process.env.SERVICE_CHECKS;
      expect(controller.targets()).toMatchObject({ enabled: true, version: 1, everyHours: 24 });
      process.env.SERVICE_CHECKS = "off";
      expect(controller.targets().enabled).toBe(false);
    });
  });
});
