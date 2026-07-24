import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/** Sends operational alerts to a generic webhook (Slack/Discord/
 * Telegram-via-adapter/custom endpoint all accept a plain JSON POST).
 * Silent no-op when ALERT_WEBHOOK_URL isn't configured -- alerting is
 * optional infrastructure, its absence must never break the thing it's
 * observing. Never throws: a failed alert delivery is logged and
 * swallowed, since the caller (e.g. the heartbeat sweep) has real work
 * to keep doing regardless of whether the notification made it out. */
@Injectable()
export class AlertingService {
  private readonly logger = new Logger(AlertingService.name);

  constructor(private readonly config: ConfigService) {}

  async send(message: string, context?: Record<string, unknown>): Promise<void> {
    const webhookUrl = this.config.get<string>("alerting.webhookUrl");
    if (!webhookUrl) {
      this.logger.debug(`Alert (no ALERT_WEBHOOK_URL configured, not sent): ${message}`);
      return;
    }

    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // "text" is the field Slack/Discord-compatible webhooks look
        // for; a custom endpoint can read whichever fields it wants
        // from the same body.
        body: JSON.stringify({ text: message, message, ...context }),
      });
      if (!res.ok) {
        this.logger.warn(`Alert webhook returned ${res.status}: ${message}`);
      }
    } catch (err) {
      this.logger.warn(`Failed to send alert webhook: ${(err as Error).message}`);
    }
  }
}
