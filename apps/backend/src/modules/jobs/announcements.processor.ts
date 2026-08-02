import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { EmailService } from "../email/email.service";
import { announcementEmail } from "../email/templates";
import { ANNOUNCEMENTS_QUEUE } from "./jobs.constants";

export interface AnnouncementJobData {
  subject: string;
  body: string;
  recipients: string[];
}

/** Runs in the background worker, not the HTTP request handler -- an
 * announcement can target an arbitrarily large recipient list, and
 * AnnouncementsService.send() only enqueues, it never blocks a request on
 * this loop. Best-effort per recipient: one failed address must not stop
 * the rest of the broadcast (EmailService.sendMail() already swallows its
 * own errors and returns a boolean, exactly for this reason). */
@Processor(ANNOUNCEMENTS_QUEUE)
export class AnnouncementsProcessor extends WorkerHost {
  private readonly logger = new Logger(AnnouncementsProcessor.name);

  constructor(private readonly emailService: EmailService) {
    super();
  }

  async process(job: Job<AnnouncementJobData>): Promise<void> {
    const { subject, body, recipients } = job.data;
    let sent = 0;
    for (const to of recipients) {
      const ok = await this.emailService.sendMail({
        to,
        subject,
        html: announcementEmail(body),
        text: `${body}

--
This is an announcement from Neoxify. Reply with "Unsubscribe" to stop receiving them.`,
        // Bulk, unlike every other send in this codebase -- see
        // SendMailInput.bulk.
        bulk: true,
      });
      if (ok) sent += 1;
    }
    this.logger.log(`Announcement "${subject}" sent to ${sent}/${recipients.length} recipient(s)`);
  }
}
