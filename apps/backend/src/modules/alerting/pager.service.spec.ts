import { HourlyBudget, PagerService } from "./pager.service";

function build(opts: { webhook: boolean; mail: Record<string, boolean>; owners?: string[] }) {
  const owners = opts.owners ?? Object.keys(opts.mail);
  const prisma = { adminUser: { findMany: jest.fn().mockResolvedValue(owners.map((email) => ({ email }))) } };
  const alerting = { deliver: jest.fn().mockResolvedValue(opts.webhook) };
  const sent: { to: string; subject: string; text: string; html: string }[] = [];
  const email = {
    sendMail: jest.fn().mockImplementation((m: { to: string; subject: string; text: string; html: string }) => {
      sent.push(m);
      return Promise.resolve(opts.mail[m.to] ?? false);
    }),
  };
  const pager = new PagerService(prisma as never, alerting as never, email as never);
  return { pager, prisma, alerting, sent };
}

describe("PagerService", () => {
  it("sends the webhook line and mails every SUPERADMIN, and says so", async () => {
    const { pager, alerting, sent, prisma } = build({ webhook: true, mail: { "a@x.test": true, "b@x.test": true } });

    const result = await pager.page({ subject: "S", text: "one\n\ntwo <b>", webhook: "W", context: { event: "e" } });

    expect(alerting.deliver).toHaveBeenCalledWith("W", { event: "e" });
    expect(prisma.adminUser.findMany).toHaveBeenCalledWith({ where: { role: "SUPERADMIN" }, select: { email: true } });
    expect(sent.map((m) => m.to)).toEqual(["a@x.test", "b@x.test"]);
    expect(sent[0].html).toBe("<p>one</p><p>two &lt;b&gt;</p>");
    expect(result).toEqual({ webhook: true, mailed: ["a@x.test", "b@x.test"], failed: [], delivered: true, error: null });
  });

  it("records a mailbox it could not reach without calling the page lost", async () => {
    const { pager } = build({ webhook: false, mail: { "a@x.test": true, "b@x.test": false } });
    const result = await pager.page({ subject: "S", text: "t" });
    expect(result.delivered).toBe(true);
    expect(result.error).toBe("could not mail b@x.test");
  });

  it("calls a page that reached nobody undelivered", async () => {
    const { pager } = build({ webhook: false, mail: { "a@x.test": false } });
    const result = await pager.page({ subject: "S", text: "t" });
    expect(result.delivered).toBe(false);
    expect(result.error).toContain("no webhook took it");
  });

  it("never throws", async () => {
    const { pager, prisma } = build({ webhook: true, mail: {} });
    prisma.adminUser.findMany.mockRejectedValue(new Error("db down"));
    const result = await pager.page({ subject: "S", text: "t" });
    expect(result).toMatchObject({ webhook: true, delivered: true, error: "db down" });
  });
});

describe("HourlyBudget", () => {
  it("allows its number an hour, then frees them as they age out", () => {
    const budget = new HourlyBudget(2);
    const t0 = 1_000_000;
    expect(budget.take(t0)).toBe(true);
    expect(budget.take(t0 + 1)).toBe(true);
    expect(budget.take(t0 + 2)).toBe(false);
    expect(budget.left(t0 + 2)).toBe(0);
    expect(budget.take(t0 + 3_600_000)).toBe(true);
  });
});
