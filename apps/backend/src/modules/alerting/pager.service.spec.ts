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
    // The text, as paragraphs on the operations shell, escaped.
    expect(sent[0].html).toMatch(/<p[^>]*>one<\/p><p[^>]*>two &lt;b&gt;<\/p>/);
    expect(sent[0].html).not.toContain("<b>");
    expect(sent[0].html).toContain("Operations mail for the owners of this Neoxify panel.");
    expect(sent[0].text).toBe("one\n\ntwo <b>");
    expect(result).toEqual({ webhook: true, mailed: ["a@x.test", "b@x.test"], failed: [], delivered: true, error: null });
  });

  it("lays a page out by its mail part: the subject as headline, the facts, then the detail", async () => {
    const { pager, sent } = build({ webhook: true, mail: { "a@x.test": true } });

    await pager.page({
      subject: "[Neoxify] node-a is down",
      text: "The whole message, for the plain part.",
      mail: {
        severity: "urgent",
        facts: [{ label: "Where", value: "node-a" }],
        body: "Only the detail.",
        panel: { path: "/nodes", label: "Open Nodes" },
      },
    });

    const { html, text, subject } = sent[0];
    expect(subject).toBe("[Neoxify] node-a is down");
    expect(html).toContain(">node-a is down</h1>");
    expect(html).toContain('class="nx-chip-urgent"');
    expect(html).toContain(">Where</td>");
    expect(html).toContain("Only the detail.");
    expect(html).not.toContain("The whole message");
    expect(html).toContain("<!--neoxify:panel:/nodes|Open Nodes-->");
    // The plain part is never the abridged one.
    expect(text).toBe("The whole message, for the plain part.");
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
