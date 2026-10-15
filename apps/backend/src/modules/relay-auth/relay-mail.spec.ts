/* eslint-disable @typescript-eslint/require-await -- Prisma stand-ins
   match the client's async signatures. */
import { UsageService } from "../usage/usage.service";
import { AnnouncementsService } from "../announcements/announcements.service";
import { deviceSlotsStub } from "../../../test/device-slots-stub";
import { MAILABLE_CUSTOMER } from "./relay-policy";

/** A relay account whose address is unconfirmed gets no mail but the
 * codes it asks for (docs/relay-last-resort.md, R3.4, F11): not the
 * usage warnings, not announcements. Anyone else unverified -- an account
 * an operator made, say -- is mailed as before. */
describe("mail to relay-unverified accounts", () => {
  it("is defined as: not (unverified and relay-unverified)", () => {
    expect(MAILABLE_CUSTOMER).toEqual({ NOT: { emailVerifiedAt: null, relayUnverifiedSince: { not: null } } });
  });

  function usage() {
    const findMany = jest.fn(async () => []);
    const prisma = { subscription: { findMany } };
    const service = new UsageService(prisma as never, {} as never, { sendMail: jest.fn() } as never, deviceSlotsStub() as never);
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    return { service, findMany };
  }

  it("leaves them out of the low-data warning", async () => {
    const { service, findMany } = usage();
    await service.sweepLowDataWarnings();
    expect((findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where.customer).toEqual(
      MAILABLE_CUSTOMER,
    );
  });

  it("leaves them out of the expiry warning", async () => {
    const { service, findMany } = usage();
    await service.sweepExpiryWarnings();
    expect((findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where.customer).toEqual(
      MAILABLE_CUSTOMER,
    );
  });

  it("leaves them out of announcements", async () => {
    const findMany = jest.fn(async () => []);
    const service = new AnnouncementsService({ subscription: { findMany } } as never, { add: jest.fn() } as never);
    await service.send({ subject: "s", body: "b" } as never);
    expect((findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where.customer).toEqual(
      MAILABLE_CUSTOMER,
    );
  });
});
