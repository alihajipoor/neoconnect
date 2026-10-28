import { Injectable, Logger } from "@nestjs/common";
import { isIP } from "node:net";
import { PrismaService } from "../../prisma/prisma.service";
import { NetworkIdentityService } from "../network-identity/network-identity.service";
import { normaliseIp } from "../network-identity/asn-table";
import type { SessionCountMessage } from "../agent-gateway/agent-messages";

/** How long after a report a node's batch can still answer for it. Six
 * stats cycles (the agent reports every 30 s): a connect that stays up is
 * seen in the first one, and a report whose device has gone quiet by the
 * third is not going to be settled by the sixth. */
export const MATCH_WINDOW_MS = 3 * 60_000;

/** How long before the report a source may have last been seen and still
 * count, on an engine that logs every connection with its time (Xray).
 * The report goes out through the tunnel the moment it is up, so the
 * device that sent it is seen at about the report's own time; the slack
 * covers the node's log granularity and the trip to us. Anything older
 * is a previous connection -- the phone before it moved from wifi to
 * mobile data, say -- and must not be taken for this one.
 *
 * Not applied to the other engines. Their ages are a handshake's
 * (WireGuard, renewed about every two minutes) or "connected now", so a
 * device that is up and sending can look minutes old; filtering on age
 * there would drop the device that sent the report and keep another of
 * the customer's. */
export const SEEN_SLACK_MS = 15_000;

/** How long after the event it describes a report may arrive and still
 * be matched. The app queues a report it could not send and flushes the
 * queue through whatever tunnel is up next -- maybe a day later, from
 * another network, on another server. What the node sees then is where
 * the customer is now, not where they were, so a late report is not
 * matched at all. */
export const MAX_REPORT_DELAY_MS = 60_000;

/** The engines that log every connection with its own time -- Xray, which
 * serves Shadowsocks too -- and so show every device on a credential at
 * once, each with a real last-seen time. */
const timedProtocol = (protocol: string) => protocol.startsWith("XRAY_") || protocol === "SHADOWSOCKS";

/** The most reports waiting at once. A few thousand is hours of connects
 * at today's volume; past it the oldest go first, which are the ones
 * closest to giving up anyway. */
export const MAX_PENDING = 5_000;

/** What can be in a batch's `sources`. Matches the agent's cap. */
const MAX_SOURCES_PER_SESSION = 8;

interface PendingReport {
  /** The client_attempts row. */
  id: string;
  /** The route's ENTRY node: the server the customer dialled. */
  nodeId: string;
  /** The customer's credentials on that route, as the node names them. */
  users: ReadonlySet<string>;
  /** Whether the route's engine logs every connection with its time, so
   * that an address's age can be trusted (timedProtocol). */
  timed: boolean;
  /** Shared credentials (no device of their own) on an engine that holds
   * one address per credential: WireGuard keeps one endpoint per key,
   * and OpenVPN and IKEv2 can replace a session when the same identity
   * connects again. Two devices on one of these show as one address --
   * whichever connected last -- so if one appears, the report is not
   * matched. */
  oneAtATime: ReadonlySet<string>;
  /** The address the row was stored with -- the server the report came
   * through. The write is conditional on it still being there. */
  serverIp: string;
  /** When the row was written, by our clock. */
  at: number;
  /** Whether the row has no network yet. */
  fillAsn: boolean;
}

/** The customer's own address, for a report that arrived through the VPN.
 *
 * A connect's success report goes out through the tunnel it has just
 * opened, so the request arrives from one of our servers and the address
 * kept is the server's. The app can say where it was before connecting
 * (`clientIp`), but no release before that change does, and customers
 * run a long tail of old versions: 116 of 129 successful connects in one
 * day of production had no customer address at all.
 *
 * The server the customer connected to did see it -- it is the source of
 * the connection -- and the agent already reads it for the device count.
 * Agents from this change on also send the addresses behind that count
 * (SessionCount.sources), and this matches them to the report: the
 * route's entry node, the customer's credentials on that route, and the
 * one address those credentials were seen from at about the time of the
 * report. Every app version benefits, because nothing on the app changes.
 *
 * What it will not do is guess. Two addresses on the customer's
 * credentials -- two devices, or one device that changed networks in the
 * seconds around the report -- leave the row as it was: which of them
 * sent the report is not knowable, and a wrong address is worse than
 * none. So does a shared credential on an engine that can only show one
 * device at a time (PendingReport.oneAtATime), a report that arrived late
 * (MAX_REPORT_DELAY_MS), and one that did not come through the route it
 * names. A batch from before the report counts for nothing, since its
 * addresses may belong to the previous connection.
 *
 * The answer comes from the first batch after the report that shows any
 * of the customer's credentials on that route. The device that sent the
 * report is connected through one of them, so it is in that batch; if
 * any other device of theirs is too, there are two addresses and the
 * report is settled as not known.
 *
 * Holds nothing but the reports still waiting, in memory, for at most
 * MATCH_WINDOW_MS. No address is stored here, kept between batches or
 * logged: the one place an address goes is the row it belongs to, which
 * the attempt log's retention sweep erases with every other address
 * (ClientAttemptsService.prune).
 */
@Injectable()
export class SourceAddressesService {
  private readonly logger = new Logger(SourceAddressesService.name);
  /** By client_attempts id, oldest first (Map keeps insertion order). */
  private readonly pending = new Map<string, PendingReport>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: NetworkIdentityService,
  ) {}

  /** A report has been stored with a server's address in place of the
   * customer's: look for the customer's in the next few batches from the
   * server they connected to. Never throws -- it runs inside the attempt
   * log's "never throws to the caller". */
  async expect(
    report: {
      id: string;
      createdAt: Date;
      /** When the app says the event happened, as the row keeps it. */
      occurredAt: Date | null;
      /** The address the row was stored with. */
      ip: string;
      asn: number | null;
      customerId: string;
      routeId: string;
    },
    now: number = Date.now(),
  ): Promise<void> {
    try {
      // Fails closed: while our own addresses are unknown every address
      // answers true, and the resolution below then drops every source
      // as ours too, so nothing is written.
      if (!(await this.identity.isOwnAddress(report.ip))) return;
      // A report flushed from the app's queue: where the customer is now
      // says nothing about where they were then. Behind by the client's
      // clock, so a clock running slow costs a match, never a wrong one.
      if (report.occurredAt && report.createdAt.getTime() - report.occurredAt.getTime() > MAX_REPORT_DELAY_MS) return;

      // The ENTRY node, not the one the report came from. On a relay route
      // the report leaves from the exit, but the customer dialled the
      // relay, and that is where their credential lives and their address
      // is seen; the exit only ever sees the relay.
      const route = await this.prisma.route.findUnique({
        where: { id: report.routeId },
        select: {
          entryProtocolConfig: { select: { nodeId: true, node: { select: { publicIp: true } } } },
          exitProtocolConfig: { select: { node: { select: { publicIp: true } } } },
        },
      });
      const nodeId = route?.entryProtocolConfig?.nodeId;
      if (!route || !nodeId) return;
      // And only a report that came through this route's own tunnel: out of
      // its exit, or its entry when that is the only server. One that came
      // through another server was sent over some other connection, and
      // the device behind it need not be on this route at all.
      const through = [route.entryProtocolConfig.node?.publicIp, route.exitProtocolConfig?.node?.publicIp]
        .filter((a): a is string => !!a)
        .map((a) => normaliseIp(a));
      if (!through.includes(normaliseIp(report.ip))) return;

      // Every credential of theirs on the route: the shared one and each
      // device's. Which one the reporting device dialled with is not in
      // the report. Named columns only -- these rows carry credentials.
      const credentials = await this.prisma.protocolUser.findMany({
        where: { routeId: report.routeId, subscription: { customerId: report.customerId } },
        select: { id: true, externalUserId: true, nodeId: true, protocol: true, sessionId: true },
      });
      const mine = credentials.filter((c) => c.nodeId === nodeId);
      if (mine.length === 0) return;
      const users = new Set(mine.map((c) => c.externalUserId));
      // One route is one engine, so this is the same for all of them.
      const timed = mine.every((c) => timedProtocol(c.protocol));
      const oneAtATime = new Set(timed ? [] : mine.filter((c) => c.sessionId === null).map((c) => c.externalUserId));

      this.sweep(now);
      while (this.pending.size >= MAX_PENDING) {
        const oldest = this.pending.keys().next().value;
        if (oldest === undefined) break;
        this.pending.delete(oldest);
      }
      this.pending.set(report.id, {
        id: report.id,
        nodeId,
        users,
        timed,
        oneAtATime,
        serverIp: report.ip,
        at: report.createdAt.getTime(),
        fillAsn: report.asn === null,
      });
    } catch (err) {
      this.logger.warn(`Could not wait for a report's address: ${(err as Error).message}`);
    }
  }

  /** One node's session report. Settles every waiting report it can
   * answer for and forgets the batch.
   *
   * Never throws. It runs inside the agent's stream handler, where an
   * exception closes the node's control stream. */
  async observe(nodeId: string, sessions: readonly SessionCountMessage[] | undefined, receivedAt: number): Promise<void> {
    try {
      this.sweep(receivedAt);
      if (this.pending.size === 0 || !sessions?.length) return;
      // A batch from before the report says nothing about it: its
      // addresses may belong to the connection before this one.
      const due = [...this.pending.values()].filter(
        (p) => p.nodeId === nodeId && receivedAt >= p.at && receivedAt - p.at <= MATCH_WINDOW_MS,
      );
      if (due.length === 0) return;

      const seen = sourcesByUser(sessions, receivedAt);
      for (const report of due) {
        const candidates = new Set<string>();
        let shared = false;
        for (const user of report.users) {
          const sources = seen.get(user);
          if (!sources?.length) continue;
          if (report.oneAtATime.has(user)) shared = true;
          for (const source of sources) {
            if (!report.timed || source.lastSeen >= report.at - SEEN_SLACK_MS) candidates.add(source.address);
          }
        }
        // None of theirs yet: the node may not have logged it by the time
        // it sent this. Wait for the next batch; expiry settles it as not
        // known.
        if (candidates.size === 0 && !shared) continue;
        // Settled here, whatever the answer -- and before the write, so a
        // batch from the same node handled meanwhile cannot settle it
        // again. Already settled by one: leave it.
        if (!this.pending.delete(report.id)) continue;
        // A shared credential that shows one device at a time: the one
        // shown may have pushed out the one that reported.
        if (shared) continue;
        const theirs: string[] = [];
        for (const address of candidates) {
          // One of our own servers is never the customer. It is what a
          // node sees when another of ours carried the connection there,
          // and then the customer is behind it, out of sight.
          if (!(await this.identity.isOwnAddress(address))) theirs.push(address);
        }
        // More than one is settled too, as not known, rather than waited
        // on. A later batch where only one is left would be a guess: the
        // device that dropped out may be the very one that sent the
        // report (a phone that reconnected, reported, and went quiet,
        // while the PC stayed up).
        if (theirs.length !== 1) continue;
        await this.fill(report, theirs[0]);
      }
    } catch (err) {
      this.logger.warn(`Matching sources from node ${nodeId} failed: ${(err as Error).message}`);
    }
  }

  /** Writes the address onto the row, if the row still has the server's.
   *
   * Conditional on that so it can only ever replace a server address: a
   * row the app's own `clientIp` already settled, or one the retention
   * sweep has erased in the meantime, is left alone. The network is
   * filled in only where the row had none -- one the client's signed
   * attestation vouched for is the reading taken before the tunnel, and
   * is not overwritten. */
  private async fill(report: PendingReport, address: string) {
    try {
      const asn = report.fillAsn ? ((await this.identity.identify(address))?.asn ?? null) : null;
      await this.prisma.clientAttempt.updateMany({
        where: { id: report.id, ip: report.serverIp },
        data: asn === null ? { ip: address } : { ip: address, asn },
      });
    } catch (err) {
      // The error's code, never its message: Prisma prints the arguments
      // of a failed call, and these carry the address.
      const code = (err as { code?: unknown }).code;
      this.logger.warn(`Could not write a report's address (${typeof code === "string" ? code : (err as Error).name})`);
    }
  }

  /** Drops the reports whose window has closed, leaving their rows as
   * they were. Oldest first, stopping at the first still open: reports
   * are added in about the order they were written, and one that slips
   * past this is still refused by the window check in observe. */
  private sweep(now: number) {
    for (const [id, report] of this.pending) {
      if (now - report.at <= MATCH_WINDOW_MS) break;
      this.pending.delete(id);
    }
  }
}

/** Every usable source in a batch, per credential, with an absolute
 * last-seen time.
 *
 * `secondsAgo` is measured on the node's clock and relative to the
 * report, so a node whose clock is off says nothing wrong; anchoring it
 * to when the batch arrived costs only the trip, which SEEN_SLACK_MS
 * covers. An address is used only if it is one: the agent sends bare
 * canonical IPs, and anything else -- a port left on, a hostname -- is
 * skipped rather than written into a row as somebody's address. */
function sourcesByUser(sessions: readonly SessionCountMessage[], receivedAt: number) {
  const byUser = new Map<string, { address: string; lastSeen: number }[]>();
  for (const session of sessions) {
    // Absent from every agent before SessionCount.sources existed.
    const sources = session.sources;
    if (!Array.isArray(sources) || sources.length === 0) continue;
    const list = byUser.get(session.externalUserId) ?? [];
    for (const source of sources.slice(0, MAX_SOURCES_PER_SESSION)) {
      if (typeof source?.address !== "string") continue;
      const address = normaliseIp(source.address.replace(/^\[(.*)\]$/, "$1")).toLowerCase();
      if (isIP(address) === 0) continue;
      const secondsAgo = Number(source.secondsAgo ?? 0);
      if (!Number.isFinite(secondsAgo)) continue;
      list.push({ address, lastSeen: receivedAt - Math.max(0, secondsAgo) * 1000 });
    }
    byUser.set(session.externalUserId, list);
  }
  return byUser;
}
