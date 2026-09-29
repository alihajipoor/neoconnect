import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { EmailService } from "../email/email.service";
import { announcementEmail, announcementText, toLocale, type Locale } from "../email/templates";
import { ANNOUNCEMENTS_QUEUE } from "./jobs.constants";

export interface AnnouncementRecipient {
  email: string;
  locale: string;
}

export interface AnnouncementJobData {
  subject: string;
  body: string;
  /** A bare string is the shape this job had before recipients carried a
   * locale (2026-09-28). Both are accepted because a deploy does not
   * drain the queue: an announcement enqueued by the old code minutes
   * before the new code starts is still sitting in Redis, and a worker
   * that threw on it would lose a broadcast an operator believes they
   * sent. Old entries render as English, which is what they would have
   * been anyway. Drop the string arm once nothing that old can be
   * queued. */
  recipients: (string | AnnouncementRecipient)[];
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
    for (const recipient of recipients) {
      const to = typeof recipient === "string" ? recipient : recipient.email;
      const locale: Locale =
        typeof recipient === "string" ? "en" : toLocale(recipient.locale);
      const ok = await this.emailService.sendMail({
        to,
        subject,
        // Only the shell is localised. The subject and body are one
        // admin's words typed into one box, and there is no translation
        // of them to reach for -- what the locale fixes is a Persian
        // announcement being laid out left to right in a Latin face.
        html: announcementEmail(locale, body),
        text: announcementText(locale, body),
        // Bulk, unlike every other send in this codebase -- see
        // SendMailInput.bulk.
        bulk: true,
      });
      if (ok) sent += 1;
    }
    this.logger.log(`Announcement "${subject}" sent to ${sent}/${recipients.length} recipient(s)`);
  }
}
