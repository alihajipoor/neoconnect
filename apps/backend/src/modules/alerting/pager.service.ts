import { Injectable, Logger } from "@nestjs/common";
import { AdminRole } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { AlertingService } from "./alerting.service";

export interface Page {
  /** The email subject. */
  subject: string;
  /** The email body, plain text; paragraphs separated by a blank line. */
  text: string;
  /** The one-line form for the webhook. The subject when absent. */
  webhook?: string;
  /** Extra fields for the webhook body. Never addresses. */
  context?: Record<string, unknown>;
}

export interface PageDelivery {
  /** The webhook took it. */
  webhook: boolean;
  /** Mailboxes the mail server accepted it for. */
  mailed: string[];
  /** Mailboxes it could not be sent to. */
  failed: string[];
  /** It reached somebody, by either route. */
  delivered: boolean;
  /** What went wrong, for the record; null when nothing did. */
  error: string | null;
}

/** The owner's pager: the alert webhook and every SUPERADMIN's mailbox,
 * the channel sign-in alerts already use.
 *
 * Unlike AlertingService.send, it says what was delivered, so a caller can
 * record it -- a page that never arrived looks, in a table, exactly like
 * one nobody has acted on yet. Never throws. Rate limits are the caller's:
 * what counts as one page and how many an hour is theirs to decide. */
@Injectable()
export class PagerService {
  private readonly logger = new Logger(PagerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerting: AlertingService,
    private readonly email: EmailService,
  ) {}

  async page(page: Page): Promise<PageDelivery> {
    const result: PageDelivery = { webhook: false, mailed: [], failed: [], delivered: false, error: null };
    try {
      result.webhook = await this.alerting.deliver(page.webhook ?? page.subject, page.context);
      const owners = await this.prisma.adminUser.findMany({
        where: { role: AdminRole.SUPERADMIN },
        select: { email: true },
      });
      const html = page.text
        .split("\n\n")
        .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
        .join("");
      for (const { email } of owners) {
        const sent = await this.email.sendMail({ to: email, subject: page.subject, text: page.text, html });
        (sent ? result.mailed : result.failed).push(email);
      }
    } catch (err) {
      this.logger.warn(`Page "${page.subject}" not fully sent: ${(err as Error).message}`);
      result.error = (err as Error).message;
    }
    result.delivered = result.webhook || result.mailed.length > 0;
    if (!result.error) {
      const problems: string[] = [];
      if (result.failed.length) problems.push(`could not mail ${result.failed.join(", ")}`);
      if (!result.delivered) problems.push("no webhook took it and no mail was sent");
      result.error = problems.length ? problems.join("; ") : null;
    }
    return result;
  }
}

/** A rolling hourly allowance, so a burst of pages cannot bury the owner.
 * In memory: a restart forgets it, which at worst allows one more hour's
 * worth. */
export class HourlyBudget {
  private spent: number[] = [];

  constructor(private readonly perHour: number) {}

  /** Takes one if any is left. */
  take(now: number = Date.now()): boolean {
    this.spent = this.spent.filter((at) => now - at < 3_600_000);
    if (this.spent.length >= this.perHour) return false;
    this.spent.push(now);
    return true;
  }

  left(now: number = Date.now()): number {
    return Math.max(0, this.perHour - this.spent.filter((at) => now - at < 3_600_000).length);
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
