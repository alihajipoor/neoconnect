import { Injectable } from "@nestjs/common";

import { PrismaService } from "../../prisma/prisma.service";
import { PlansService } from "../plans/plans.service";
import { UpdatesService } from "../updates/updates.service";

/** A node is considered stale once it has been quiet for this long, even if
 * its stored status still says ONLINE. The heartbeat sweep flips the column
 * eventually; this makes the answer honest in the window before it does. */
const HEARTBEAT_STALE_MS = 3 * 60 * 1000;

export interface StatusSummary {
  nodes: { total: number; online: number; offline: number; stale: number };
  routes: { total: number; enabled: number };
  regions: { region: string; online: number; total: number }[];
  checkedAt: string;
}

/** Exactly the columns this module is allowed to read. Written out rather
 * than inferred so the privacy boundary is visible in the type, not buried
 * in a `select` twenty lines away. */
interface NodeRow {
  region: string;
  status: string;
  lastHeartbeatAt: Date | null;
}

interface RouteRow {
  isEnabled: boolean;
}

interface PlanRow {
  name: string;
  priceUsd: { toString(): string };
  durationDays: number;
  dataCapBytes: bigint | null;
  maxDownloadMbps: number | null;
  maxUploadMbps: number | null;
  maxConcurrentConnections: number | null;
}

export interface PublicPlan {
  name: string;
  priceUsd: string;
  durationDays: number;
  dataCapGb: number | null;
  maxDownloadMbps: number | null;
  maxUploadMbps: number | null;
  maxConcurrentConnections: number | null;
}

/**
 * Read-only facts about the deployment, shaped for public consumption.
 *
 * Everything here is safe to repeat in a Discord channel: counts and regions,
 * never a node's address, credentials, or which customer is on what. That
 * constraint is the whole reason this sits in its own module rather than the
 * bot calling the admin endpoints -- the boundary is enforced by what the
 * queries select, not by the caller's good intentions.
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlansService,
    private readonly updates: UpdatesService,
  ) {}

  async status(): Promise<StatusSummary> {
    const [nodes, routes] = (await Promise.all([
      this.prisma.node.findMany({
        // Region is the coarsest useful location; publicIp deliberately absent.
        select: { region: true, status: true, lastHeartbeatAt: true },
      }),
      this.prisma.route.findMany({ select: { isEnabled: true } }),
    ])) as [NodeRow[], RouteRow[]];

    const cutoff = Date.now() - HEARTBEAT_STALE_MS;
    const isStale = (node: NodeRow) =>
      node.status === "ONLINE" && (node.lastHeartbeatAt?.getTime() ?? 0) < cutoff;
    const isUp = (node: NodeRow) => node.status === "ONLINE" && !isStale(node);

    const byRegion = new Map<string, { region: string; online: number; total: number }>();
    for (const node of nodes) {
      const entry = byRegion.get(node.region) ?? { region: node.region, online: 0, total: 0 };
      entry.total += 1;
      if (isUp(node)) entry.online += 1;
      byRegion.set(node.region, entry);
    }

    return {
      nodes: {
        total: nodes.length,
        online: nodes.filter(isUp).length,
        offline: nodes.filter((n) => n.status === "OFFLINE" || n.status === "DISABLED").length,
        stale: nodes.filter(isStale).length,
      },
      routes: {
        total: routes.length,
        enabled: routes.filter((r) => r.isEnabled).length,
      },
      regions: [...byRegion.values()].sort((a, b) => a.region.localeCompare(b.region)),
      checkedAt: new Date().toISOString(),
    };
  }

  async publicPlans(): Promise<PublicPlan[]> {
    const plans = (await this.plans.listActive()) as PlanRow[];

    return plans.map((plan) => ({
      name: plan.name,
      // Decimal and BigInt do not survive JSON.stringify; convert at the edge
      // rather than leaving the caller to discover that the hard way.
      priceUsd: plan.priceUsd.toString(),
      durationDays: plan.durationDays,
      dataCapGb:
        plan.dataCapBytes === null ? null : Math.round(Number(plan.dataCapBytes) / 1024 ** 3),
      maxDownloadMbps: plan.maxDownloadMbps ?? null,
      maxUploadMbps: plan.maxUploadMbps ?? null,
      maxConcurrentConnections: plan.maxConcurrentConnections ?? null,
    }));
  }

  /** Where to send someone who asks the bot for the app. */
  async download(): Promise<{ installerUrl: string | null }> {
    try {
      return { installerUrl: await this.updates.installerUrl() };
    } catch {
      // The updates feed is upstream and occasionally unavailable. A bot
      // reply of "download from the website" beats a 500.
      return { installerUrl: null };
    }
  }
}
