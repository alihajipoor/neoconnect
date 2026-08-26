import { SupportTicketStatus } from "@prisma/client";
import { SupportService } from "./support.service";
import { listWindow } from "../../common/pagination";

/** What `GET /support/tickets` had instead of paging.
 *
 * A hardcoded `take: 200` and no `skip`. That is not a bound but a
 * ceiling: the 201st conversation was unreachable through the API, and
 * nothing said so -- the rail rendered 200 rows and looked complete,
 * which is the same failure mode as a total inferred from a page
 * length. The default stays 200 so the current page is unchanged; what
 * changes is that there is now a way past it and a count that admits the
 * rest exist.
 *
 * Each test fails against the hardcoded version. */
describe("GET /support/tickets bounds", () => {
  type Table = Record<string, jest.Mock>;
  let prisma: { supportTicket: Table; $transaction: jest.Mock };
  let service: SupportService;

  const INBOX = Array.from({ length: 512 }, (_, i) => ({
    id: `t-${i}`,
    subject: `Ticket ${i}`,
    status: i % 4 === 0 ? SupportTicketStatus.OPEN : SupportTicketStatus.RESOLVED,
  }));

  const DEFAULT_LIMITS = { defaultTake: 200, maxTake: 500 };

  beforeEach(() => {
    prisma = {
      supportTicket: {
        findMany: jest.fn((args: any) => {
          const matching = args.where?.status
            ? INBOX.filter((t) => t.status === args.where.status)
            : INBOX;
          return Promise.resolve(
            matching.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? matching.length)),
          );
        }),
        count: jest.fn((args: any) =>
          Promise.resolve(
            args?.where?.status
              ? INBOX.filter((t) => t.status === args.where.status).length
              : INBOX.length,
          ),
        ),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    service = new SupportService(prisma as any, {} as any);
  });

  function argsOf() {
    return prisma.supportTicket.findMany.mock.calls[0][0];
  }

  /** 200 on purpose. A page load that suddenly showed half the inbox
   * would read to an operator as conversations having disappeared. */
  it("still serves 200 by default, the number the hardcoded take served", async () => {
    const page = await service.listTickets(undefined, listWindow({}, DEFAULT_LIMITS));

    expect(argsOf().take).toBe(200);
    expect(argsOf().skip).toBe(0);
    expect(page.items).toHaveLength(200);
  });

  /** The whole point of the change: the 201st ticket had no route to it
   * at all. */
  it("can reach past the 200th ticket, which the hardcoded take could not", async () => {
    const page = await service.listTickets(
      undefined,
      listWindow({ take: "50", skip: "200" }, DEFAULT_LIMITS),
    );

    expect(argsOf()).toMatchObject({ take: 50, skip: 200 });
    expect(page.items[0].id).toBe("t-200");
  });

  it("reports the count of every matching ticket, not the page length", async () => {
    const page = await service.listTickets(undefined, listWindow({}, DEFAULT_LIMITS));

    expect(prisma.supportTicket.count).toHaveBeenCalled();
    expect(page.total).toBe(512);
    expect(page.items.length).toBeLessThan(page.total);
  });

  it("refuses to widen past the cap however large a take is asked for", async () => {
    await service.listTickets(undefined, listWindow({ take: "100000" }, DEFAULT_LIMITS));

    expect(argsOf().take).toBe(500);
  });

  /** The rail counts "needs reply" client-side over whatever it was
   * given, so a status-filtered count has to be the count of that
   * status and not of the inbox. */
  it("counts through the same status filter it reads through", async () => {
    const page = await service.listTickets(
      SupportTicketStatus.OPEN,
      listWindow({}, DEFAULT_LIMITS),
    );

    expect(argsOf().where).toEqual({ status: SupportTicketStatus.OPEN });
    expect(prisma.supportTicket.count.mock.calls[0][0].where).toEqual({
      status: SupportTicketStatus.OPEN,
    });
    expect(page.total).toBe(128);
  });

  it("takes the page and the count in one round trip", async () => {
    await service.listTickets(undefined, listWindow({}, DEFAULT_LIMITS));

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2);
  });

  describe("the projection", () => {
    it("names its columns instead of returning the row", async () => {
      await service.listTickets(undefined, listWindow({}, DEFAULT_LIMITS));

      expect(argsOf().select).toBeDefined();
      expect(argsOf().include).toBeUndefined();
    });

    it("still carries what the rail renders", async () => {
      await service.listTickets(undefined, listWindow({}, DEFAULT_LIMITS));

      const select = argsOf().select;
      for (const column of ["id", "subject", "status", "lastMessageAt"]) {
        expect(select[column]).toBe(true);
      }
      expect(select.customer.select).toEqual({ id: true, email: true });
      expect(select._count.select.messages).toBe(true);
    });

    /** The customer's own unread marker, read by the app to decide
     * whether to show a dot. The operator's inbox has never used it. */
    it("leaves customerLastReadAt out", async () => {
      await service.listTickets(undefined, listWindow({}, DEFAULT_LIMITS));

      expect(argsOf().select.customerLastReadAt).toBeUndefined();
    });

    /** `lastMessageAt` is the timestamp the rail shows and sorts on; the
     * full row is still available from `GET /support/tickets/:id`. */
    it.each(["createdAt", "updatedAt"])("leaves %s out, since no row shows it", async (column) => {
      await service.listTickets(undefined, listWindow({}, DEFAULT_LIMITS));

      expect(argsOf().select[column]).toBeUndefined();
    });

    /** An unbounded `messages` include on a list route is how one long
     * argument becomes a slow endpoint for everybody. The count is what
     * the rail could use; the thread comes from the detail route. */
    it("does not pull the messages of every conversation", async () => {
      await service.listTickets(undefined, listWindow({}, DEFAULT_LIMITS));

      expect(argsOf().select.messages).toBeUndefined();
    });
  });
});
