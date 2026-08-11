import { Injectable, Logger } from "@nestjs/common";
import * as nodemailer from "nodemailer";
import { EmailSettingsService, ResolvedEmailSettings } from "./email-settings.service";
import { EmailBrandService } from "./email-brand.service";

export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Marks this as bulk rather than transactional, which adds the
   * unsubscribe headers below. Transactional mail must NOT set it: there
   * is nothing to opt out of when the message is a code the customer
   * just asked for, and offering one there invites them to unsubscribe
   * from their own password resets. */
  bulk?: boolean;
}

/** What Gmail and Yahoo look for on bulk mail.
 *
 * Both have expected List-Unsubscribe on bulk senders since their 2024
 * rules, and its absence counts against the sending domain -- which
 * matters more here than for an established sender, since this domain
 * has no reputation banked.
 *
 * A mailto rather than the one-click URL form on purpose: honouring a
 * click needs an endpoint and somewhere to record the preference, and
 * neither exists yet. Advertising an action nobody handles would be
 * worse than this, which at least lands where a human reads it. Add
 * List-Unsubscribe-Post alongside a real endpoint when there is one.
 */
function bulkHeaders(fromAddress: string): Record<string, string> {
  const domain = fromAddress.split("@")[1] ?? "neoxify.site";
  return {
    "List-Unsubscribe": `<mailto:${fromAddress}?subject=Unsubscribe>`,
    "List-Id": `Neoxify announcements <announcements.${domain}>`,
  };
}

/** Sends real customer-facing email via the operator's own SMTP server
 * (settings configured in the panel, see EmailSettingsService). Silent
 * no-op when email isn't configured/enabled -- same philosophy as
 * AlertingService: this is optional infrastructure, and its absence must
 * never break the flow that's trying to use it (e.g. registration).
 * Callers that need the caller to know whether a send actually happened
 * (password reset, verification) still get a boolean back, but none of
 * them should throw on failure -- a bad SMTP config is an admin
 * misconfiguration to fix in the panel, not a reason to 500 a signup. */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  // Cached across calls, keyed by a fingerprint of the settings used to
  // build it -- rebuilt automatically if the admin changes SMTP settings
  // without needing a process restart, without reconnecting on every send.
  private cachedTransporter: { fingerprint: string; transporter: nodemailer.Transporter } | null = null;

  constructor(
    private readonly emailSettingsService: EmailSettingsService,
    private readonly brand: EmailBrandService,
  ) {}

  async sendMail(input: SendMailInput): Promise<boolean> {
    const settings = await this.emailSettingsService.resolve();
    if (!settings) {
      this.logger.debug(`Email (SMTP not configured/enabled, not sent): "${input.subject}" -> ${input.to}`);
      return false;
    }

    try {
      const transporter = this.getTransporter(settings);
      await transporter.sendMail({
        // Display name, not a bare address: a raw `noreply@...` in the
        // sender column reads as machine-generated bulk mail to both the
        // recipient and to spam filters that score sender presentation.
        from: { name: "Neoxify", address: settings.fromAddress },
        to: input.to,
        subject: input.subject,
        // The single point every message passes through, which is
        // why the brand chrome is substituted here rather than in
        // each template -- a call site cannot forget it.
        html: await this.brand.apply(input.html),
        text: input.text,
        ...(input.bulk ? { headers: bulkHeaders(settings.fromAddress) } : {}),
      });
      return true;
    } catch (err) {
      this.logger.warn(`Failed to send email "${input.subject}" to ${input.to}: ${(err as Error).message}`);
      return false;
    }
  }

  private getTransporter(settings: ResolvedEmailSettings): nodemailer.Transporter {
    const fingerprint = `${settings.host}:${settings.port}:${settings.secure}:${settings.username}`;
    if (this.cachedTransporter?.fingerprint === fingerprint) {
      return this.cachedTransporter.transporter;
    }
    const transporter = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: { user: settings.username, pass: settings.password },
    });
    this.cachedTransporter = { fingerprint, transporter };
    return transporter;
  }
}
