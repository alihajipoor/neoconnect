import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InvoiceStatus, Prisma } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../../prisma/prisma.service";
import type { ListWindow, Page } from "../../common/pagination";
import { EmailService } from "../email/email.service";
import { invoiceIssuedEmail, invoiceOverdueEmail } from "../email/templates";

export interface InvoiceLineItem {
  description: string;
  amountUsd: string;
}

/** Pins what an invoice-link token may be used for, so one cannot be
 * presented as a session token or a verification link. Same discipline as
 * the email-verification and password-reset tokens. */
const INVOICE_DOCUMENT_PURPOSE = "invoice-document";

/** Long enough that an invoice emailed today is still openable when
 * someone goes looking for it at the end of the month, short enough that
 * a forwarded email does not hand out a permanent link. The invoice
 * remains available in the app regardless. */
const INVOICE_LINK_TTL = "60d";

/** Exactly the columns a row of the operator's invoice table renders.
 *
 * `lineItemsJson` is the notable omission: it is the biggest column on
 * the model and the list shows a single total, not a breakdown. The
 * printable document reads the whole invoice through
 * `GET /invoices/:id`, which is one row rather than a page of them. */
const INVOICE_LIST_FIELDS = {
  id: true,
  invoiceNumber: true,
  planNameSnapshot: true,
  amountUsd: true,
  currency: true,
  status: true,
  issuedAt: true,
  customer: { select: { email: true } },
  paymentTransaction: { select: { provider: true } },
} satisfies Prisma.InvoiceSelect;

/** One `where` for the list and its count, so a filter can never be
 * applied to the page but not to the total it is reported against. */
function whereFor(filters: { customerId?: string; status?: InvoiceStatus }): Prisma.InvoiceWhereInput {
  return {
    ...(filters.customerId ? { customerId: filters.customerId } : {}),
    ...(filters.status ? { status: filters.status } : {}),
  };
}

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {}

  /** Issues the invoice for a payment that has just cleared.
   *
   * Called from BillingService.confirmPayment, in the same flow that
   * activates the subscription -- an invoice that only exists if a
   * separate job later runs is an invoice that sometimes doesn't exist.
   *
   * Issued already PAID, which is the normal case here: the product is
   * prepaid and settles at purchase, so the document is closer to a
   * receipt than a demand. dueAt stays null for those; it's only
   * meaningful for something billed ahead of payment.
   *
   * Idempotent on paymentTransactionId, because webhooks legitimately
   * arrive more than once and both providers document that. Without this
   * a retried webhook would mint a second invoice for the same money.
   */
  async issueForPayment(paymentTransactionId: string) {
    const existing = await this.prisma.invoice.findUnique({ where: { paymentTransactionId } });
    if (existing) return existing;

    const payment = await this.prisma.paymentTransaction.findUnique({
      where: { id: paymentTransactionId },
      include: { subscription: { include: { plan: true } } },
    });
    if (!payment) throw new NotFoundException("Payment transaction not found");

    const plan = payment.subscription?.plan;
    const planName = plan?.name ?? "Neoxify subscription";
    const periodStart = payment.subscription?.startAt ?? payment.createdAt;
    const periodEnd = payment.subscription?.expireAt ?? payment.createdAt;

    const lineItems: InvoiceLineItem[] = [
      { description: `${planName} subscription`, amountUsd: payment.amountUsd.toString() },
    ];

    const invoice = await this.prisma.invoice.create({
      data: {
        invoiceNumber: await this.nextInvoiceNumber(),
        customerId: payment.customerId,
        subscriptionId: payment.subscriptionId,
        paymentTransactionId: payment.id,
        // Copied, not referenced: renaming or deleting the plan later
        // must not rewrite what this customer was billed for.
        planNameSnapshot: planName,
        amountUsd: payment.amountUsd,
        currency: payment.currency,
        status: InvoiceStatus.PAID,
        periodStart,
        periodEnd,
        paidAt: new Date(),
        lineItemsJson: lineItems as unknown as Prisma.InputJsonValue,
      },
    });

    // Best-effort, like every other send in this codebase: a mail
    // failure must never unwind a payment that has already cleared.
    const customer = await this.prisma.customer.findUnique({ where: { id: invoice.customerId } });
    if (customer) {
      await this.emailService.sendMail({
        to: customer.email,
        ...invoiceIssuedEmail({
          invoiceNumber: invoice.invoiceNumber,
          planName: planName,
          amountUsd: invoice.amountUsd.toString(),
          currency: invoice.currency,
          documentUrl: this.documentUrl(invoice.id),
        }),
      });
    }

    return invoice;
  }

  /** Where a customer can view this invoice, when the public address is
   * configured. Omitted rather than guessed if it isn't -- a link to the
   * wrong host is worse than no link, and the email reads fine without
   * one. */
  private documentUrl(invoiceId: string): string | undefined {
    const base = this.config.get<string>("publicApiUrl");
    if (!base) return undefined;

    // Carries its own signed token rather than pointing at the
    // customer-authenticated route. An emailed link is opened in whatever
    // browser the mail was read in -- usually a phone -- which has no
    // session, so the guarded endpoint could only ever answer 401. It did
    // exactly that as soon as PUBLIC_API_URL was configured and this link
    // started appearing at all.
    //
    // Same shape as the email-verification link: a short-lived JWT whose
    // purpose is pinned, so it cannot be replayed against anything else.
    const token = this.jwt.sign(
      { sub: invoiceId, purpose: INVOICE_DOCUMENT_PURPOSE },
      {
        secret: this.config.get<string>("customerJwt.accessSecret"),
        expiresIn: INVOICE_LINK_TTL,
      },
    );
    return `${base.replace(/\/$/, "")}/invoice-document?token=${encodeURIComponent(token)}`;
  }

  /** Resolves an emailed invoice link back to an invoice.
   *
   * The token is the authorisation: it names one invoice, was signed by
   * this server, and expires. No ownership check is needed beyond that,
   * and none is possible -- there is no session here by design.
   */
  async getByDocumentToken(token: string) {
    let payload: { sub?: string; purpose?: string };
    try {
      payload = await this.jwt.verifyAsync(token, {
        secret: this.config.get<string>("customerJwt.accessSecret"),
      });
    } catch {
      throw new NotFoundException("This invoice link has expired or is not valid");
    }
    if (payload.purpose !== INVOICE_DOCUMENT_PURPOSE || !payload.sub) {
      throw new NotFoundException("This invoice link has expired or is not valid");
    }
    return this.get(payload.sub);
  }

  /** `INV-<year>-<n>`, with the counter coming from a Postgres sequence.
   *
   * Not a count of existing rows: a webhook and an admin action can issue
   * at the same instant, both read the same count, and collide on the
   * unique index. nextval() is handed out exactly once per caller without
   * anyone taking a lock.
   *
   * The number is padded but not reset per year -- a gap-free sequence
   * matters more to an accountant than the digits restarting each
   * January, and resetting reintroduces exactly the race this avoids.
   */
  private async nextInvoiceNumber(): Promise<string> {
    const [row] = await this.prisma.$queryRaw<{ nextval: bigint }[]>`SELECT nextval('invoice_number_seq')`;
    return `INV-${new Date().getFullYear()}-${row.nextval.toString().padStart(6, "0")}`;
  }

  /** Includes the customer's email and how they paid, because an invoice
   * list that shows only ids is unusable for the one job an operator
   * opens it to do: find a specific person's invoice. */
  list(filters: { customerId?: string; status?: InvoiceStatus } = {}) {
    return this.prisma.invoice.findMany({
      where: whereFor(filters),
      include: {
        customer: { select: { email: true } },
        paymentTransaction: { select: { provider: true } },
      },
      orderBy: { issuedAt: "desc" },
    });
  }

  /** The operator's invoice list, paged and projected.
   *
   * Split from `list` above rather than parameterised into it, because
   * the two have genuinely different requirements. `list` serves
   * `GET /customer/invoices`, where the result is bounded by the one
   * customer it belongs to and the full row is what a client may already
   * be reading. This one serves `GET /invoices`, where both filters are
   * optional -- so the default query was every invoice ever issued,
   * ordered newest first, growing by a row per customer per billing
   * period and never shrinking.
   *
   * The projection drops `lineItemsJson`, the largest column on the
   * model, along with the period bounds and the two foreign keys. None
   * of them appears in a cell of the panel's table; the document view
   * fetches the single invoice it renders from `GET /invoices/:id`.
   */
  async listPage(
    filters: { customerId?: string; status?: InvoiceStatus },
    window: ListWindow,
  ): Promise<Page<Prisma.InvoiceGetPayload<{ select: typeof INVOICE_LIST_FIELDS }>>> {
    const where = whereFor(filters);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.invoice.findMany({
        where,
        select: INVOICE_LIST_FIELDS,
        orderBy: { issuedAt: "desc" },
        take: window.take,
        skip: window.skip,
      }),
      this.prisma.invoice.count({ where }),
    ]);
    return { items, total };
  }

  async get(id: string) {
    const invoice = await this.prisma.invoice.findUnique({ where: { id } });
    if (!invoice) throw new NotFoundException("Invoice not found");
    return invoice;
  }

  /** A customer may only ever read their own. Scoped in the query rather
   * than fetched-then-checked, so an id belonging to someone else is
   * indistinguishable from one that doesn't exist. */
  async getOwned(id: string, customerId: string) {
    const invoice = await this.prisma.invoice.findFirst({ where: { id, customerId } });
    if (!invoice) throw new NotFoundException("Invoice not found");
    return invoice;
  }

  /** Voids an invoice. The only status change an admin can make by hand.
   *
   * Deliberately not a delete: an invoice is a financial record, and the
   * correction for a wrong one is a visible void, not a disappearance.
   * Voiding something already paid is refused -- that's a refund, which
   * is a different object with different accounting, and pretending
   * otherwise would quietly understate revenue.
   */
  async void(id: string) {
    const invoice = await this.get(id);
    if (invoice.status === InvoiceStatus.PAID) {
      throw new BadRequestException(
        "This invoice is already paid. Refund the payment instead of voiding the invoice -- voiding would leave the money unaccounted for.",
      );
    }
    if (invoice.status === InvoiceStatus.VOID) return invoice;
    return this.prisma.invoice.update({ where: { id }, data: { status: InvoiceStatus.VOID } });
  }

  /** Revenue actually collected, by period. Counts PAID invoices only --
   * issued-but-unpaid is a claim, not income. */
  async summary(since: Date) {
    const paid = await this.prisma.invoice.findMany({
      where: { status: InvoiceStatus.PAID, paidAt: { gte: since } },
      select: { amountUsd: true, planNameSnapshot: true, paymentTransaction: { select: { provider: true } } },
    });

    const byPlan = new Map<string, number>();
    const byProvider = new Map<string, number>();
    let total = 0;

    for (const invoice of paid) {
      const amount = Number(invoice.amountUsd);
      total += amount;
      byPlan.set(invoice.planNameSnapshot, (byPlan.get(invoice.planNameSnapshot) ?? 0) + amount);
      const provider = invoice.paymentTransaction?.provider ?? "UNKNOWN";
      byProvider.set(provider, (byProvider.get(provider) ?? 0) + amount);
    }

    return {
      since,
      invoiceCount: paid.length,
      totalUsd: total.toFixed(2),
      byPlan: [...byPlan].map(([name, amountUsd]) => ({ name, amountUsd: amountUsd.toFixed(2) })),
      byProvider: [...byProvider].map(([provider, amountUsd]) => ({ provider, amountUsd: amountUsd.toFixed(2) })),
    };
  }

  /** Flips overdue invoices and reports which ones changed, so the caller
   * can notify. Only touches ISSUED ones with a due date in the past --
   * paid and voided invoices are terminal.
   *
   * Expected to do nothing most of the time: almost every invoice here is
   * paid at issue. It exists for slow-settling crypto and, later,
   * reseller terms. */
  async markOverdue(now = new Date()) {
    const due = await this.prisma.invoice.findMany({
      where: { status: InvoiceStatus.ISSUED, dueAt: { not: null, lt: now } },
    });
    if (due.length === 0) return [];

    await this.prisma.invoice.updateMany({
      where: { id: { in: due.map((i) => i.id) } },
      data: { status: InvoiceStatus.OVERDUE },
    });

    for (const invoice of due) {
      const customer = await this.prisma.customer.findUnique({ where: { id: invoice.customerId } });
      if (!customer) continue;
      await this.emailService.sendMail({
        to: customer.email,
        ...invoiceOverdueEmail({
          invoiceNumber: invoice.invoiceNumber,
          amountUsd: invoice.amountUsd.toString(),
          currency: invoice.currency,
          documentUrl: this.documentUrl(invoice.id),
        }),
      });
    }

    this.logger.log(`Marked ${due.length} invoice(s) overdue`);
    return due;
  }
}
