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
      select: { customer: { select: { email: true } } },
      distinct: ["customerId"],
    });
    const recipients = [...new Set(subscriptions.map((s) => s.customer.email))];

    if (recipients.length > 0) {
      await this.queue.add("send", { subject: dto.subject, body: dto.body, recipients });
    }
    return { recipientCount: recipients.length };
  }
}
