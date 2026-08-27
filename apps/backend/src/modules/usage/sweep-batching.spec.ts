import { SWEEP_BATCH_SIZE } from "../../common/batching";
import { cursoredFindMany, rowIds } from "../../../test/cursored";
import { UsageService } from "./usage.service";

/** The property the sweeps must have, stated once: **every due row is
 * processed**, however many there are.
 *
 * This is the test the pagination audit was pointing at when it refused
 * to put a `take` on these:
 *
 * > A sweep that expires 100 of 300 due subscriptions leaves 200 live
 * > and reports success.
 *
 * So each of these runs a sweep over more rows than one batch holds and
 * counts what actually happened to them. Replace the cursor in the
 * service with a plain `take` and every one of them fails on the count
 * -- which is what makes them worth having rather than merely green.
 *
 * The real `SWEEP_BATCH_SIZE` is used rather than an injected small one,
 * so these exercise the constant that actually ships.
 */
const OVER_ONE_BATCH = SWEEP_BATCH_SIZE + 137;

describe("UsageService sweeps process every due row, not the first batch of them", () => {
  function build(subscriptions: Record<string, unknown>[]) {
    const findMany = cursoredFindMany(subscriptions as ({ id: string } & Record<string, unknown>)[]);
    const update = jest.fn().mockResolvedValue({});
    const prisma = {
      subscription: {
        findMany,
        update,
        // expireSubscription/suspendForQuota re-read the row they are
        // about to change; ACTIVE so they proceed.
        findUnique: jest.fn(({ where }: { where: { id: string } }) =>
          Promise.resolve({ id: where.id, status: "ACTIVE" }),
        ),
      },
      // disableProtocolUsers: nothing to disable keeps this focused on
      // the sweep's own loop.
      protocolUser: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
    };
    const emailService = { sendMail: jest.fn().mockResolvedValue(undefined) };
    const service = new UsageService(prisma as never, {} as never, emailService as never);
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    return { service, prisma, findMany, update, emailService };
  }

  it("expires every subscription that is due, across as many batches as it takes", async () => {
    const past = new Date("2020-01-01");
    const { service, findMany, update } = build(
      rowIds(OVER_ONE_BATCH, "sub").map((id) => ({ id, status: "ACTIVE", expireAt: past })),
    );

    const expired = await service.sweepExpiry();

    expect(expired).toBe(OVER_ONE_BATCH);
    // Once per subscription, and each one really was written.
    expect(update).toHaveBeenCalledTimes(OVER_ONE_BATCH);
    // Two full reads plus the short one, plus the empty read that ends
    // it. If this were one read the sweep would have been unbounded; if
    // it were one read with a `take` it would have stopped at 500.
    expect(findMany.wheres).toHaveLength(3);
    expect(findMany.wheres[0]).not.toHaveProperty("id");
    expect(findMany.wheres[1]).toHaveProperty("id.gt");
  });

  it("keeps the filter on every batch, not just the first", async () => {
    const past = new Date("2020-01-01");
    const { service, findMany } = build(
      rowIds(OVER_ONE_BATCH, "sub").map((id) => ({ id, status: "ACTIVE", expireAt: past })),
    );

    await service.sweepExpiry();

    // A cursor that carried the position but dropped the predicate would
    // sweep rows it has no business touching.
    for (const where of findMany.wheres) {
      expect(where).toMatchObject({ status: "ACTIVE" });
      expect(where).toHaveProperty("expireAt");
    }
  });

  it("uses one clock for the whole sweep, so nothing falls between two batches", async () => {
    const past = new Date("2020-01-01");
    const { service, findMany } = build(
      rowIds(OVER_ONE_BATCH, "sub").map((id) => ({ id, status: "ACTIVE", expireAt: past })),
    );

    await service.sweepExpiry();

    const clocks = findMany.wheres.map((w) => (w as { expireAt: { lt: Date } }).expireAt.lt.getTime());
    expect(new Set(clocks).size).toBe(1);
  });

  it("suspends every over-cap subscription, across batches", async () => {
    const { service, prisma } = build(
      rowIds(OVER_ONE_BATCH, "sub").map((id) => ({
        id,
        status: "ACTIVE",
        dataCapBytes: 10n,
        dataUsedBytes: 99n,
      })),
    );

    const suspended = await service.sweepQuota();

    expect(suspended).toBe(OVER_ONE_BATCH);
    expect(prisma.subscription.update).toHaveBeenCalledTimes(OVER_ONE_BATCH);
  });

  it("counts only the over-cap rows, not every row it read", async () => {
    // Half over cap, half nowhere near it, interleaved so the split
    // straddles the batch boundary rather than sitting on one side.
    const rows = rowIds(OVER_ONE_BATCH, "sub").map((id, i) => ({
      id,
      status: "ACTIVE",
      dataCapBytes: 100n,
      dataUsedBytes: i % 2 === 0 ? 500n : 1n,
    }));
    const { service } = build(rows);

    const suspended = await service.sweepQuota();

    expect(suspended).toBe(rows.filter((r) => r.dataUsedBytes >= r.dataCapBytes).length);
  });

  it("emails every customer whose data is running low, across batches", async () => {
    const { service, emailService } = build(
      rowIds(OVER_ONE_BATCH, "sub").map((id) => ({
        id,
        status: "ACTIVE",
        dataCapBytes: 2_000_000_000n,
        dataUsedBytes: 1_900_000_000n,
        customer: { email: `${id}@example.com` },
      })),
    );

    const warned = await service.sweepLowDataWarnings();

    expect(warned).toBe(OVER_ONE_BATCH);
    expect(emailService.sendMail).toHaveBeenCalledTimes(OVER_ONE_BATCH);
    // The addresses are distinct, so this is not one customer warned
    // repeatedly -- it is every customer warned once.
    const recipients = new Set(
      emailService.sendMail.mock.calls.map((c: [{ to: string }]) => c[0].to),
    );
    expect(recipients.size).toBe(OVER_ONE_BATCH);
  });

  it("never reads a credential column to find an address to send to", async () => {
    const { service, findMany } = build([]);

    await service.sweepLowDataWarnings();

    // `include: { customer: true }` here used to read every candidate's
    // passwordHash and both one-time codes to use one field.
    const args = findMany.mock.calls[0][0] as {
      select: { customer: { select: Record<string, boolean> } };
      include?: unknown;
    };
    expect(args.include).toBeUndefined();
    expect(Object.keys(args.select.customer.select)).toEqual(["email"]);
  });

  it("warns every subscription expiring soon, across batches", async () => {
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const { service, emailService } = build(
      rowIds(OVER_ONE_BATCH, "sub").map((id) => ({
        id,
        status: "ACTIVE",
        expireAt: soon,
        customer: { email: `${id}@example.com` },
      })),
    );

    const warned = await service.sweepExpiryWarnings();

    expect(warned).toBe(OVER_ONE_BATCH);
    expect(emailService.sendMail).toHaveBeenCalledTimes(OVER_ONE_BATCH);
  });

  /** A sweep that dies half way IS partial. The requirement is only that
   * it is not partial *quietly*: the job has to fail, and the message has
   * to say how far it got so an operator knows what state things are in. */
  it("fails loudly when a batch throws, rather than reporting a short success", async () => {
    const past = new Date("2020-01-01");
    const { service, prisma } = build(
      rowIds(OVER_ONE_BATCH, "sub").map((id) => ({ id, status: "ACTIVE", expireAt: past })),
    );
    // Fails once the second batch is under way.
    let n = 0;
    prisma.subscription.update.mockImplementation(() => {
      n += 1;
      if (n > SWEEP_BATCH_SIZE) return Promise.reject(new Error("database went away"));
      return Promise.resolve({});
    });

    await expect(service.sweepExpiry()).rejects.toThrow(/sweepExpiry aborted after \d+ rows/);
    await expect(service.sweepExpiry()).rejects.toThrow("database went away");
  });
});
