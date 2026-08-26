import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, SupportTicketStatus } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import type { ListWindow, Page } from "../../common/pagination";
import { EmailService } from "../email/email.service";
import { supportReplyEmail } from "../email/templates";
import { UpdateSupportSettingsDto } from "./dto/update-support-settings.dto";

/** Newest first, and capped. A thread is a conversation, not an archive
 * -- nobody scrolls past this, and an unbounded include is how one long
 * argument becomes a slow endpoint for everybody. */
const MAX_MESSAGES = 200;

/** What the inbox rail draws, and nothing more.
 *
 * `customerLastReadAt` is the notable omission: it is the *customer's*
 * unread marker, read by the app to decide whether to show a dot, and
 * the operator's inbox has never had a use for it. `createdAt` and
 * `updatedAt` go for the ordinary reason that no row shows them --
 * `lastMessageAt` is the timestamp the rail renders and the one it
 * sorts on. The full row still arrives on `GET /support/tickets/:id`,
 * which is where the open conversation comes from. */
const TICKET_LIST_FIELDS = {
  id: true,
  subject: true,
  status: true,
  lastMessageAt: true,
  customer: { select: { id: true, email: true } },
  _count: { select: { messages: true } },
} satisfies Prisma.SupportTicketSelect;

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  // ------------------------------------------------------------- settings

  async settings() {
    const existing = await this.prisma.supportSettings.findFirst();
    if (existing) return existing;
    return this.prisma.supportSettings.create({ data: {} });
  }

  async updateSettings(dto: UpdateSupportSettingsDto) {
    const current = await this.settings();
    return this.prisma.supportSettings.update({
      where: { id: current.id },
      data: {
        acceptingTickets: dto.acceptingTickets,
        awayMessage: dto.awayMessage === "" ? null : dto.awayMessage,
        replyWithinHours: dto.replyWithinHours,
      },
    });
  }

  // ------------------------------------------------------------- customer

  /** Everything the app needs to render the support screen in one call:
   * whether it can start a conversation, and the ones it already has. */
  async overviewFor(customerId: string) {
    const [settings, tickets] = await Promise.all([
      this.settings(),
      this.prisma.supportTicket.findMany({
        where: { customerId },
        orderBy: { lastMessageAt: "desc" },
        select: {
          id: true,
          subject: true,
          status: true,
          lastMessageAt: true,
          customerLastReadAt: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      acceptingTickets: settings.acceptingTickets,
      awayMessage: settings.awayMessage,
      replyWithinHours: settings.replyWithinHours,
      tickets: tickets.map((ticket) => ({
        ...ticket,
        // Computed here rather than in the client, so the app does not
        // have to know the rule and two clients cannot disagree about
        // what counts as unread.
        unread:
          ticket.customerLastReadAt === null ||
          ticket.lastMessageAt > ticket.customerLastReadAt,
      })),
    };
  }

  async openTicket(customerId: string, subject: string, body: string) {
    const settings = await this.settings();
    if (!settings.acceptingTickets) {
      throw new ForbiddenException(
        settings.awayMessage ?? "Support is closed to new messages right now.",
      );
    }

    return this.prisma.supportTicket.create({
      data: {
        customerId,
        subject: subject.trim(),
        // Read by definition: they just wrote it.
        customerLastReadAt: new Date(),
        messages: { create: { fromAdmin: false, body: body.trim() } },
      },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
  }

  /** One thread, with its messages, for the customer who owns it. */
  async threadFor(customerId: string, ticketId: string) {
    const ticket = await this.mustOwn(customerId, ticketId);

    // Opening a thread is reading it. Done here rather than by a
    // separate call the client has to remember to make.
    await this.prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { customerLastReadAt: new Date() },
    });

    return this.withMessages(ticket.id);
  }

  async replyAsCustomer(customerId: string, ticketId: string, body: string) {
    await this.mustOwn(customerId, ticketId);
    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.supportMessage.create({
        data: { ticketId, fromAdmin: false, body: body.trim() },
      }),
      this.prisma.supportTicket.update({
        where: { id: ticketId },
        data: {
          // Writing to a resolved thread reopens it. The alternative is
          // telling somebody their follow-up went nowhere, which is how
          // support systems earn their reputation.
          status: SupportTicketStatus.OPEN,
          lastMessageAt: now,
          customerLastReadAt: now,
        },
      }),
    ]);

    return this.withMessages(ticketId);
  }

  private async mustOwn(customerId: string, ticketId: string) {
    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: ticketId } });
    // Not-found rather than forbidden for somebody else's ticket: a
    // distinct "forbidden" would confirm the id exists, which is a free
    // enumeration oracle over other customers' conversations.
    if (!ticket || ticket.customerId !== customerId) {
      throw new NotFoundException("That conversation does not exist");
    }
    return ticket;
  }

  // ---------------------------------------------------------------- admin

  /** The operator's inbox -- paged, where it used to be truncated.
   *
   * The old `take: 200` with no `skip` was not a bound so much as a
   * ceiling: the 201st conversation was simply unreachable, and nothing
   * said so -- the rail rendered 200 rows and looked complete. The
   * default stays 200 so today's page is byte-for-byte what it was, but
   * there is now a `skip` to reach past it and an `X-Total-Count` that
   * tells the operator the ones beyond exist.
   *
   * The count is taken over the same WHERE as the page, so filtering by
   * status reports that status's total and not the whole inbox's. */
  async listTickets(
    status: SupportTicketStatus | undefined,
    window: ListWindow,
  ): Promise<Page<Prisma.SupportTicketGetPayload<{ select: typeof TICKET_LIST_FIELDS }>>> {
    const where: Prisma.SupportTicketWhereInput | undefined = status ? { status } : undefined;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.supportTicket.findMany({
        where,
        // Waiting-on-us first, then most recently active. An inbox sorted
        // purely by time buries the one thing that needs answering under
        // conversations already dealt with.
        orderBy: [{ status: "asc" }, { lastMessageAt: "desc" }],
        select: TICKET_LIST_FIELDS,
        take: window.take,
        skip: window.skip,
      }),
      this.prisma.supportTicket.count({ where }),
    ]);

    return { items, total };
  }

  async ticket(ticketId: string) {
    const ticket = await this.withMessages(ticketId);
    if (!ticket) {
      throw new NotFoundException("That conversation does not exist");
    }
    return ticket;
  }

  async replyAsAdmin(ticketId: string, body: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: { customer: { select: { email: true } } },
    });
    if (!ticket) {
      throw new NotFoundException("That conversation does not exist");
    }

    await this.prisma.$transaction([
      this.prisma.supportMessage.create({
        data: { ticketId, fromAdmin: true, body: body.trim() },
      }),
      this.prisma.supportTicket.update({
        where: { id: ticketId },
        data: { status: SupportTicketStatus.ANSWERED, lastMessageAt: new Date() },
      }),
    ]);

    // The app may not be open, and a reply nobody sees is the same as no
    // reply. Best-effort: a mail failure must not lose the answer that
    // has already been written.
    const rendered = supportReplyEmail(ticket.subject, body.trim());
    void this.email
      .sendMail({
        to: ticket.customer.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      })
      .catch(() => undefined);

    return this.withMessages(ticketId);
  }

  async setStatus(ticketId: string, status: SupportTicketStatus) {
    await this.ticket(ticketId);
    return this.prisma.supportTicket.update({ where: { id: ticketId }, data: { status } });
  }

  private withMessages(ticketId: string) {
    return this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: {
        customer: { select: { id: true, email: true } },
        messages: { orderBy: { createdAt: "asc" }, take: MAX_MESSAGES },
      },
    });
  }
}
