import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { UsageService } from "../usage/usage.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { ReferralsService } from "../referrals/referrals.service";
import { ClientAttemptsService } from "../client-attempts/client-attempts.service";
import { ReachabilityService } from "../reachability/reachability.service";
import { ProtocolUsersService } from "../protocol-users/protocol-users.service";
import { RelayAuthService } from "../relay-auth/relay-auth.service";
import { BlockWatchService } from "../block-watch/block-watch.service";
import { SWEEPS_QUEUE, STALE_PENDING_AFTER_MS } from "./jobs.constants";

@Processor(SWEEPS_QUEUE)
export class SweepsProcessor extends WorkerHost {
  private readonly logger = new Logger(SweepsProcessor.name);

  constructor(
    private readonly usageService: UsageService,
    private readonly invoicesService: InvoicesService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly referralsService: ReferralsService,
    private readonly clientAttemptsService: ClientAttemptsService,
    private readonly reachabilityService: ReachabilityService,
    private readonly protocolUsersService: ProtocolUsersService,
    private readonly relayAuthService: RelayAuthService,
    private readonly blockWatchService: BlockWatchService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case "quota": {
        const count = await this.usageService.sweepQuota();
        this.logger.log(`quota sweep: suspended ${count} subscription(s) the real-time path missed`);
        break;
      }
      case "expiry": {
        const count = await this.usageService.sweepExpiry();
        this.logger.log(`expiry sweep: expired ${count} subscription(s)`);
        break;
      }
      case "low-data-warning": {
        const count = await this.usageService.sweepLowDataWarnings();
        this.logger.log(`low-data warning sweep: warned ${count} subscription(s)`);
        break;
      }
      case "expiry-warning": {
        const count = await this.usageService.sweepExpiryWarnings();
        this.logger.log(`expiry warning sweep: warned ${count} subscription(s)`);
        break;
      }
      case "invoice-overdue": {
        // Expected to find nothing almost every run: this product is
        // prepaid, so invoices are issued already paid and never carry a
        // due date. Only slow-settling crypto leaves one outstanding.
        const overdue = await this.invoicesService.markOverdue();
        if (overdue > 0) {
          this.logger.log(`invoice overdue sweep: marked ${overdue} invoice(s) overdue`);
        }
        break;
      }
      case "referral": {
        const granted = await this.referralsService.sweep();
        if (granted > 0) {
          this.logger.log(`referral sweep: granted ${granted} free period(s)`);
        }
        break;
      }
      case "stale-pending": {
        const count = await this.subscriptionsService.cancelStalePending(STALE_PENDING_AFTER_MS);
        if (count > 0) {
          this.logger.log(`stale pending sweep: cancelled ${count} abandoned purchase attempt(s)`);
        }
        break;
      }
      case "client-attempt-retention": {
        // Not tidying -- this is the only thing that actually enforces
        // the retention promise on a table of IP addresses belonging to
        // people in a country where holding them is dangerous. The
        // service logs the count itself when it deletes anything.
        await this.clientAttemptsService.prune();
        break;
      }
      case "reachability": {
        // Probes each node from inside Iran and opens or resolves an
        // incident. Swallows its own failures by design: a monitor that
        // can fail the queue it runs on is a monitor that takes the
        // other sweeps down with it.
        const results = await this.reachabilityService.runCycle();
        const bad = results.filter((r) => r.verdict !== "REACHABLE");
        if (bad.length) {
          this.logger.warn(
            `reachability: ${bad.map((r) => `${r.nodeName}=${r.verdict}(${r.probesOk}/${r.probesAnswered})`).join(", ")}`,
          );
        } else if (results.length) {
          this.logger.log(`reachability: all ${results.length} node(s) reachable`);
        }
        break;
      }
      case "device-credentials": {
        // Takes signed-out and long-idle devices' VPN credentials off the
        // nodes (docs/per-device-credentials.md). Logs its own summary
        // when it did anything.
        await this.protocolUsersService.sweepDeadSessionCredentials();
        break;
      }
      case "relay-unverified": {
        // Unpaid unverified relay accounts idle 30 days, which frees their
        // address; paused during a declared intranet and the 30 days
        // after (docs/relay-last-resort.md, R3.8).
        await this.relayAuthService.sweepUnverified();
        break;
      }
      case "block-watch": {
        // Looks for servers that seem blocked and tells the owner; never
        // changes one. Off unless BLOCK_WATCH says otherwise, and swallows
        // its own failures like the reachability probe.
        const results = await this.blockWatchService.runCycle();
        const flagged = results.filter((r) => r.verdict || r.outage);
        if (flagged.length) {
          this.logger.warn(
            `block watch: ${flagged.map((r) => `${r.nodeName}=${r.verdict ?? "outage"}[${r.firing.join("+")}]`).join(", ")}`,
          );
        }
        break;
      }
      default:
        this.logger.warn(`unknown sweep job name: ${job.name}`);
    }
  }
}
