/* eslint-disable @typescript-eslint/require-await -- the Prisma stand-in
   matches the client's async signatures. */
import { RelayAccountsService } from "./relay-accounts.service";
import { hashRecoveryCode, newRecoveryCode } from "../customer-auth/recovery-code";

/** Support moving an account to a new address on its recovery code alone
 * (docs/relay-last-resort.md, R3.9). */
describe("RelayAccountsService.moveAddress", () => {
  function setup(relayUnverifiedSince: Date | null) {
    const code = newRecoveryCode();
    const writes: Record<string, unknown>[] = [];
    const prisma = {
      customer: {
        findUnique: jest.fn(async ({ where }: { where: { id?: string; email?: string } }) =>
          where.id ? { id: where.id, recoveryCodeHash: hashRecoveryCode(code), relayUnverifiedSince } : null,
        ),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          writes.push(data);
          return {};
        }),
      },
    };
    return { service: new RelayAccountsService(prisma as never), code, writes };
  }

  /** The guard holds an unverified account to the capability set only when
   * it is relay-unverified; an address nobody has proven must not open
   * card payments and support because the account came in another way. */
  it("holds the moved account to the capability set until its new address is confirmed", async () => {
    const { service, code, writes } = setup(null);
    await service.moveAddress("customer-1", code, "new@example.com");
    expect(writes[0]).toMatchObject({
      email: "new@example.com",
      emailVerifiedAt: null,
      relayUnverifiedSince: expect.any(Date),
    });
  });

  it("keeps the date the account first became relay-unverified", async () => {
    const since = new Date("2026-10-01T00:00:00Z");
    const { service, code, writes } = setup(since);
    await service.moveAddress("customer-1", code, "new@example.com");
    expect(writes[0].relayUnverifiedSince).toEqual(since);
  });
});
