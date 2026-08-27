import { SWEEP_BATCH_SIZE } from "../../common/batching";
import { cursoredFindMany, rowIds } from "../../../test/cursored";
import { AgentGatewayService } from "../agent-gateway/agent-gateway.service";
import { encryptCredentials } from "./credentials-crypto";
import { InvoicesService } from "../invoices/invoices.service";
import { ProvisioningBackfillService } from "./provisioning-backfill.service";

/** The other three unbounded internal reads that were converted, and the
 * same question asked of each: does it still see every row once there
 * are more of them than a batch holds?
 *
 * Grouped here rather than spread across three files because the
 * property is one property, and it is the property that a `take` breaks.
 */
const OVER_ONE_BATCH = SWEEP_BATCH_SIZE + 61;

/** The re-assert that scales with the customer base.
 *
 * This is the sharpest of the seventeen: routes are a dozen rows, but
 * provisioned users are one per customer per route, and this runs every
 * 60 seconds per connected node. It is also **not self-draining** -- a
 * user is still ACTIVE after being re-asserted -- so a `take` here would
 * not merely have been short: it would have re-asserted the same first
 * page for ever and left every customer past it dark on a node that had
 * just come back.
 */
describe("AgentGatewayService re-asserts every provisioned user on a node", () => {
  function build(count: number) {
    const findMany = cursoredFindMany(
      rowIds(count, "pu").map((id) => ({
        id,
        nodeId: "node-1",
        protocol: "XRAY_VLESS_REALITY",
        externalUserId: `ext-${id}`,
        status: "ACTIVE",
        credentialsJson: encryptCredentials({ uuid: `uuid-${id}` }),
        protocolConfig: { transport: "TCP", inboundTag: null },
      })),
    );
    const prisma = { protocolUser: { findMany } };
    const service = new AgentGatewayService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    const enqueue = jest.spyOn(service, "enqueueCommand").mockResolvedValue(undefined as never);
    return { service, findMany, enqueue };
  }

  /** `reassertProvisionedUsers` is private; reached the way the reconnect
   * path reaches it, which is also how the existing re-assert spec does
   * it. */
  function reassert(service: AgentGatewayService, nodeId: string) {
    return (
      service as unknown as {
        reassertProvisionedUsers: (n: string, o?: { persist: boolean }) => Promise<void>;
      }
    ).reassertProvisionedUsers(nodeId, { persist: true });
  }

  it("re-creates every active user, not just the first batch of them", async () => {
    const { service, enqueue } = build(OVER_ONE_BATCH);

    await reassert(service, "node-1");

    expect(enqueue).toHaveBeenCalledTimes(OVER_ONE_BATCH);
    // Distinct users, so this is every customer once rather than one
    // customer repeatedly -- the exact failure a cursorless `take`
    // produces on a predicate that stays satisfied.
    const ids = new Set(
      enqueue.mock.calls.map((c) => (c[2] as { externalUserId: string }).externalUserId),
    );
    expect(ids.size).toBe(OVER_ONE_BATCH);
  });

  it("keeps the node scoping on every batch", async () => {
    const { service, findMany } = build(OVER_ONE_BATCH);

    await reassert(service, "node-1");

    // Re-asserting another node's users onto this one is never a
    // permissible change, batching or not.
    for (const where of findMany.wheres) {
      expect(where).toMatchObject({ nodeId: "node-1", status: "ACTIVE" });
    }
  });
});

/** The boot backfill. Also not self-draining. */
describe("ProvisioningBackfillService covers every live subscription", () => {
  it("provisions past the first batch", async () => {
    const findMany = cursoredFindMany(rowIds(OVER_ONE_BATCH, "sub").map((id) => ({ id })));
    const provisionAll = jest.fn().mockResolvedValue({ created: [{ id: "a" }], revoked: [] });
    const service = new ProvisioningBackfillService(
      { subscription: { findMany } } as never,
      { provisionAll } as never,
    );
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);

    const result = await service.run();

    expect(provisionAll).toHaveBeenCalledTimes(OVER_ONE_BATCH);
    expect(result.considered).toBe(OVER_ONE_BATCH);
    expect(result.added).toBe(OVER_ONE_BATCH);
    // Every subscription is a different one.
    expect(new Set(provisionAll.mock.calls.map((c) => c[0])).size).toBe(OVER_ONE_BATCH);
  });
});

/** The overdue-invoice sweep. Self-draining -- ISSUED becomes OVERDUE --
 * but the `updateMany` had to move inside the batch for that to be true,
 * so it is worth pinning. */
describe("InvoicesService.markOverdue marks every due invoice", () => {
  function build(count: number) {
    const findMany = cursoredFindMany(
      rowIds(count, "inv").map((id) => ({
        id,
        invoiceNumber: `INV-2026-${id}`,
        amountUsd: { toString: () => "9.99" },
        currency: "usd",
        customer: { email: `${id}@example.com` },
      })),
    );
    const prisma = {
      invoice: { findMany, updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const emailService = { sendMail: jest.fn().mockResolvedValue(undefined) };
    const service = new InvoicesService(
      prisma as never,
      emailService as never,
      // publicApiUrl unset, so no document link is built and the jwt
      // signer below is never reached.
      { get: () => undefined } as never,
      {} as never,
    );
    jest.spyOn(service["logger"], "log").mockImplementation(() => undefined);
    return { service, prisma, emailService, findMany };
  }

  it("flips and notifies past the first batch", async () => {
    const { service, emailService } = build(OVER_ONE_BATCH);

    const marked = await service.markOverdue(new Date("2026-06-01"));

    expect(marked).toBe(OVER_ONE_BATCH);
    expect(emailService.sendMail).toHaveBeenCalledTimes(OVER_ONE_BATCH);
  });

  it("flips each batch as it goes, not the whole set at the end", async () => {
    const { service, prisma } = build(OVER_ONE_BATCH);

    await service.markOverdue(new Date("2026-06-01"));

    // Two updateMany calls, one per batch. A single call keyed on the
    // whole result would mean the sweep had accumulated every row --
    // and, worse, that the first batch's flip had not happened before
    // the second batch was read.
    expect(prisma.invoice.updateMany).toHaveBeenCalledTimes(2);
    const flipped = prisma.invoice.updateMany.mock.calls.flatMap(
      (c: [{ where: { id: { in: string[] } } }]) => c[0].where.id.in,
    );
    expect(new Set(flipped).size).toBe(OVER_ONE_BATCH);
  });

  it("takes the address off the join rather than reading the customer row", async () => {
    const { service, findMany } = build(0);

    await service.markOverdue(new Date("2026-06-01"));

    // It used to do a `customer.findUnique` per invoice with no select,
    // pulling `passwordHash`, `tokenVersion` and both one-time codes to
    // use one column -- an N+1 and a credential read in one.
    const args = findMany.mock.calls[0][0] as {
      select: { customer: { select: Record<string, boolean> } };
    };
    expect(Object.keys(args.select.customer.select)).toEqual(["email"]);
    // And `lineItemsJson`, the largest column on the model, is not read.
    expect(args.select).not.toHaveProperty("lineItemsJson");
  });
});
