import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { AlertingService } from "../alerting/alerting.service";
import { CreateNodeDto } from "./dto/create-node.dto";

@Injectable()
export class NodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly alerting: AlertingService,
  ) {}

  list() {
    return this.prisma.node.findMany({ orderBy: { createdAt: "desc" } });
  }

  async get(id: string) {
    const node = await this.prisma.node.findUnique({ where: { id } });
    if (!node) {
      throw new NotFoundException("Node not found");
    }
    return node;
  }

  create(dto: CreateNodeDto) {
    return this.prisma.node.create({ data: dto });
  }

  async remove(id: string) {
    await this.get(id);
    await this.prisma.node.delete({ where: { id } });
  }

  /** Called by the agent gateway on successful Hello / on stream close /
   * on stale-heartbeat sweep -- kept as a single narrow write path so
   * status transitions are easy to audit, rather than scattering
   * `prisma.node.update` calls. Also the one place that alerts on a
   * real ONLINE<->OFFLINE transition (compares against the prior status
   * so a redundant call -- e.g. the sweep and a stream-close event both
   * racing to mark the same node OFFLINE -- doesn't double-alert). */
  async setStatus(id: string, status: "ONLINE" | "OFFLINE", extra?: { agentVersion?: string }) {
    const previous = await this.prisma.node.findUnique({ where: { id }, select: { status: true, name: true } });

    await this.prisma.node.update({
      where: { id },
      data: {
        status,
        lastHeartbeatAt: status === "ONLINE" ? new Date() : undefined,
        agentVersion: extra?.agentVersion,
      },
    });

    if (previous && previous.status !== status) {
      const label = status === "OFFLINE" ? "went OFFLINE" : "is back ONLINE";
      await this.alerting.send(`Node "${previous.name}" (${id}) ${label}`, {
        event: status === "OFFLINE" ? "node_offline" : "node_online",
        nodeId: id,
        nodeName: previous.name,
      });
    }
  }

  async touchHeartbeat(id: string) {
    await this.prisma.node.update({ where: { id }, data: { lastHeartbeatAt: new Date() } });
  }
}
