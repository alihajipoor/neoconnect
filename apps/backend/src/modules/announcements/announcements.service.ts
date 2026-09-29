import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Queue } from "bullmq";
import { PrismaService } from "../../prisma/prisma.service";
import { ANNOUNCEMENTS_QUEUE } from "../jobs/jobs.constants";
import { AnnouncementJobData } from "../jobs/announcements.processor";
import { SendAnnouncementDto } from "./dto/send-announcement.dto";

@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(ANNOUNCEMENTS_QUEUE) private readonly queue: Queue<AnnouncementJobData>,
  ) {}

  /** Resolves the filtered recipient list up front (a single query, cheap
   * even for a large customer base) and hands it to the background
   * worker as a plain string array -- the actual per-recipient sending
   * happens in AnnouncementsProcessor, never in this request handler. */
  async send(dto: SendAnnouncementDto): Promise<{ recipientCount: number }> {
    const where: Prisma.SubscriptionWhereInput = {};
    if (dto.statuses?.length) where.status = { in: dto.statuses };
    if (dto.planIds?.length) where.planId = { in: dto.planIds };
    if (dto.routeIds?.length) where.protocolUsers = { some: { routeId: { in: dto.routeIds } } };

    const subscriptions = await this.prisma.subscription.findMany({
      where,
      select: { customer: { select: { email: true, locale: true } } },
      distinct: ["customerId"],
    });
    // Deduplicated on the address, as before -- `distinct` is on
    // customerId, so two subscriptions held by one customer are already
    // one row, but an address shared by two customer records was not.
    // The locale rides along rather than being looked up again in the
    // worker: the worker would then need a database of its own reason to
    // exist, and the list is already in hand here.
    const byEmail = new Map<string, { email: string; locale: string }>();
    for (const s of subscriptions) {
      if (!byEmail.has(s.customer.email)) {
        byEmail.set(s.customer.email, { email: s.customer.email, locale: s.customer.locale });
      }
    }
    const recipients = [...byEmail.values()];

    if (recipients.length > 0) {
      await this.queue.add("send", { subject: dto.subject, body: dto.body, recipients });
    }
    return { recipientCount: recipients.length };
  }
}
