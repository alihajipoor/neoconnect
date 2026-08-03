import { ProvisioningBackfillService } from "./provisioning-backfill.service";

/** Runs against the live fleet at every boot, so what it does when
 * things go wrong matters as much as what it does when they go right. */
describe("ProvisioningBackfillService", () => {
  function build(subscriptionIds: string[], provisionAll: jest.Mock) {
    const prisma = {
      subscription: {
        findMany: jest.fn().mockResolvedValue(subscriptionIds.map((id) => ({ id }))),
      },
    };
    const service = new ProvisioningBackfillService(prisma as never, { provisionAll } as never);
    return { service, prisma };
  }

  it("brings every live subscription up to its full set of credentials", async () => {
    const provisionAll = jest.fn().mockResolvedValue([{ id: "a" }, { id: "b" }]);
    const { service } = build(["sub-1", "sub-2"], provisionAll);

    await expect(service.run()).resolves.toEqual({ added: 4, failed: 0, considered: 2 });
    expect(provisionAll).toHaveBeenCalledTimes(2);
  });

  /** One bad subscription must not deny every later one its fallbacks --
   * a sweep that stops at the first error is worse than no sweep, since
   * it looks like it ran. */
  it("keeps going when one subscription fails", async () => {
    const provisionAll = jest
      .fn()
      .mockRejectedValueOnce(new Error("route vanished"))
      .mockResolvedValue([{ id: "a" }]);
    const { service } = build(["sub-bad", "sub-1", "sub-2"], provisionAll);

    await expect(service.run()).resolves.toEqual({ added: 2, failed: 1, considered: 3 });
  });

  /** A subscription over its cap still exists and returns on renewal.
   * Provisioning grants no access by itself -- the credentials stay
   * disabled until renewal re-enables them -- so skipping these would
   * only leave them short of fallbacks the day they come back. */
  it("includes suspended subscriptions, not only active ones", async () => {
    const { service, prisma } = build([], jest.fn());

    await service.run();

    const { where } = prisma.subscription.findMany.mock.calls[0][0] as {
      where: { status: { in: string[] } };
    };
    expect(where.status.in.sort()).toEqual(["ACTIVE", "SUSPENDED"]);
  });

  /** Boot must not depend on it: the API coming up is more important
   * than the sweep finishing, or even succeeding. */
  it("never lets a failure escape onModuleInit", () => {
    const { service } = build([], jest.fn());
    jest.spyOn(service, "run").mockRejectedValue(new Error("database asleep"));

    expect(() => service.onModuleInit()).not.toThrow();
  });
});
