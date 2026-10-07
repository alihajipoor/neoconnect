import { cursoredFindMany } from "../../../test/cursored";
import { ProvisioningBackfillService } from "./provisioning-backfill.service";

/** Runs against the live fleet at every boot, so what it does when
 * things go wrong matters as much as what it does when they go right. */
describe("ProvisioningBackfillService", () => {
  const NOTHING_SWITCHED_OFF = { removed: 0, disabled: 0, failed: 0 };

  function build(
    subscriptionIds: string[],
    provisionAll: jest.Mock,
    leaked: { id: string; subscription: { status: string } }[] = [],
  ) {
    // Cursor-aware: the backfill reads in batches, and a
    // `mockResolvedValue` would hand back the same page forever --
    // indistinguishable from a working cursor and from a broken one.
    const prisma = {
      subscription: {
        findMany: cursoredFindMany(subscriptionIds.map((id) => ({ id }))),
      },
      protocolUser: { findMany: cursoredFindMany(leaked) },
    };
    const protocolUsers = {
      provisionAll,
      remove: jest.fn().mockResolvedValue(undefined),
      setEnabled: jest.fn().mockResolvedValue({}),
    };
    const service = new ProvisioningBackfillService(prisma as never, protocolUsers as never);
    return { service, prisma, protocolUsers };
  }

  /** The sweep that used to be the quietest one it could perform.
   *
   * provisionAll only added when this service was written, so the
   * summary counted created credentials and stayed silent when there
   * were none. Once it also revoked, a boot that deleted credentials
   * from live nodes and created nothing printed no summary at all --
   * the most destructive outcome producing the least output. On
   * 2026-08-16 such a sweep revoked 36 credentials.
   */
  it("counts and reports a sweep that only revoked", async () => {
    const provisionAll = jest.fn().mockResolvedValue({ created: [], revoked: ["pu-1", "pu-2"] });
    const { service } = build(["sub-1"], provisionAll);
    const warn = jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);

    await expect(service.run()).resolves.toEqual({ added: 0, revoked: 2, failed: 0, considered: 1, switchedOff: NOTHING_SWITCHED_OFF });

    // Warn, not log: removing a customer's access is not routine even
    // when it is correct.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("revoked 2");
  });

  it("stays silent when there was genuinely nothing to do", async () => {
    // The steady state, and the reason the summary is conditional at
    // all: a line every boot saying zero trains you to ignore the line
    // that matters.
    const provisionAll = jest.fn().mockResolvedValue({ created: [], revoked: [] });
    const { service } = build(["sub-1"], provisionAll);
    const warn = jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);
    const log = jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);

    await service.run();

    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("brings every live subscription up to its full set of credentials", async () => {
    const provisionAll = jest.fn().mockResolvedValue({ created: [{ id: "a" }, { id: "b" }], revoked: [] });
    const { service } = build(["sub-1", "sub-2"], provisionAll);

    await expect(service.run()).resolves.toEqual({ added: 4, revoked: 0, failed: 0, considered: 2, switchedOff: NOTHING_SWITCHED_OFF });
    expect(provisionAll).toHaveBeenCalledTimes(2);
  });

  /** One bad subscription must not deny every later one its fallbacks --
   * a sweep that stops at the first error is worse than no sweep, since
   * it looks like it ran. */
  it("keeps going when one subscription fails", async () => {
    const provisionAll = jest
      .fn()
      .mockRejectedValueOnce(new Error("route vanished"))
      .mockResolvedValue({ created: [{ id: "a" }], revoked: [] });
    const { service } = build(["sub-bad", "sub-1", "sub-2"], provisionAll);

    await expect(service.run()).resolves.toEqual({ added: 2, revoked: 0, failed: 1, considered: 3, switchedOff: NOTHING_SWITCHED_OFF });
  });

  /** A subscription over its cap still exists, and a route its plan no
   * longer allows is taken off it now rather than at renewal.
   * provisionAll adds nothing to it (it used to, ENABLED), so including
   * it only ever takes access away. */
  it("includes suspended subscriptions, not only active ones", async () => {
    const { service, prisma } = build([], jest.fn());

    await service.run();

    const { where } = prisma.subscription.findMany.mock.calls[0][0] as {
      where: { status: { in: string[] } };
    };
    expect(where.status.in.sort()).toEqual(["ACTIVE", "SUSPENDED"]);
  });

  /** The credentials provisionAll used to mint on subscriptions nobody
   * was paying for. Stopping new ones left the existing ones live: the
   * re-assert kept them on their nodes and expiry and quota only act on
   * ACTIVE subscriptions. */
  it("removes an unpaid attempt's credentials and switches off a lapsed subscription's", async () => {
    const { service, protocolUsers } = build([], jest.fn(), [
      { id: "pu-pending", subscription: { status: "PENDING" } },
      { id: "pu-cancelled", subscription: { status: "CANCELLED" } },
      { id: "pu-expired", subscription: { status: "EXPIRED" } },
      { id: "pu-suspended", subscription: { status: "SUSPENDED" } },
    ]);
    const warn = jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);

    const result = await service.run();

    expect(protocolUsers.remove.mock.calls.map((c) => c[0]).sort()).toEqual(["pu-cancelled", "pu-pending"]);
    expect(protocolUsers.setEnabled.mock.calls.sort()).toEqual([
      ["pu-expired", false],
      ["pu-suspended", false],
    ]);
    expect(result.switchedOff).toEqual({ removed: 2, disabled: 2, failed: 0 });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("removed 2"))).toBe(true);
  });

  it("asks only for enabled credentials of subscriptions that are not ACTIVE", async () => {
    const { service, prisma } = build([], jest.fn());

    await service.run();

    expect(prisma.protocolUser.findMany.mock.calls[0][0].where).toMatchObject({
      status: "ACTIVE",
      subscription: { status: { not: "ACTIVE" } },
    });
  });

  it("keeps switching the rest off when one node cannot be told", async () => {
    const { service, protocolUsers } = build([], jest.fn(), [
      { id: "pu-1", subscription: { status: "PENDING" } },
      { id: "pu-2", subscription: { status: "PENDING" } },
    ]);
    jest.spyOn(service["logger"], "warn").mockImplementation(() => undefined);
    protocolUsers.remove.mockRejectedValueOnce(new Error("node unreachable"));

    const { switchedOff } = await service.run();

    expect(protocolUsers.remove).toHaveBeenCalledTimes(2);
    expect(switchedOff).toEqual({ removed: 1, disabled: 0, failed: 1 });
  });

  /** Boot must not depend on it: the API coming up is more important
   * than the sweep finishing, or even succeeding. */
  it("never lets a failure escape onModuleInit", () => {
    const { service } = build([], jest.fn());
    jest.spyOn(service, "run").mockRejectedValue(new Error("database asleep"));

    expect(() => service.onModuleInit()).not.toThrow();
  });
});
