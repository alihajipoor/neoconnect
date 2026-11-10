import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { isIP } from "node:net";
import { PrismaService } from "../../prisma/prisma.service";
import { DoorProber } from "./door-prober";
import {
  candidatePorts,
  DOOR_FRESH_MS,
  doorDomains,
  doorPorts,
  doorSni,
  knownNames,
  nodeDoorsEnabled,
  recordSighting,
  sightingChange,
} from "./door";

/** Nodes checked at once. Each check is one connection and one small
 * request, so this is about not opening the whole fleet in one instant
 * and not letting a few dead nodes hold up the rest. */
const NODES_AT_ONCE = 4;

/** How long after a node comes online its door is first asked for. A new
 * node's inbounds are sent to it right after its agent says hello, and
 * asked at once it would have nothing listening yet. */
const ONLINE_SETTLE_MS = 45_000;

const NODE_FIELDS = {
  id: true,
  name: true,
  publicIp: true,
  mirrorHost: true,
  doorPort: true,
  doorSni: true,
  doorPin: true,
  doorPreviousPin: true,
  doorPinChangedAt: true,
  doorVerifiedAt: true,
  protocolConfigs: {
    where: { isEnabled: true },
    select: {
      protocol: true,
      listenPort: true,
      security: true,
      publicParamsJson: true,
    },
  },
} satisfies Prisma.NodeSelect;

type LearnedNode = Prisma.NodeGetPayload<{ select: typeof NODE_FIELDS }>;

/** Which nodes are asked: every one that is set up and not retired. One
 * whose agent has gone quiet is asked too -- it goes on serving the
 * customers it holds, and its mirror with them. */
const ASKED = {
  status: { in: ["ONLINE", "OFFLINE"] },
} satisfies Prisma.NodeWhereInput;

export interface DoorCycle {
  checked: number;
  verified: number;
}

/** Learns each node's door (door.ts) by asking the node itself, on a
 * timer (modules/jobs) and shortly after a node comes online.
 *
 * It only ever reads from a node and writes six columns of that node's
 * row. A check that fails writes nothing: the door's last passing check
 * simply grows old, and past DOOR_FRESH_MS it is no longer handed out
 * (`doorOf`). What was learned is kept, so a node that comes back with
 * the same key is the same door.
 *
 * Nothing here throws into its caller, and no request waits on it: the
 * credential list reads the columns, never this service. */
@Injectable()
export class NodeDoorsService implements OnModuleDestroy {
  private readonly logger = new Logger(NodeDoorsService.name);
  private running = false;
  /** Nodes already said to have lost their door, so it is said once. In
   * memory: after a restart a door still gone is said once more. */
  private readonly lapsed = new Set<string>();
  /** Checks waiting for a node that has just come online to settle. */
  private readonly settling = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly prober: DoorProber,
  ) {}

  onModuleDestroy() {
    for (const timer of this.settling.values()) clearTimeout(timer);
    this.settling.clear();
  }

  /** Checks every node once. Does nothing while doors are switched off
   * (NODE_DOORS=off) or the previous round is still running. */
  async runCycle(now: () => Date = () => new Date()): Promise<DoorCycle> {
    if (!nodeDoorsEnabled() || this.running) return { checked: 0, verified: 0 };
    this.running = true;
    try {
      const nodes = await this.prisma.node.findMany({
        where: ASKED,
        select: NODE_FIELDS,
        orderBy: { name: "asc" },
      });
      const waiting = [...nodes];
      let verified = 0;
      const worker = async () => {
        for (let node = waiting.shift(); node; node = waiting.shift()) {
          if (await this.learn(node, now)) verified += 1;
        }
      };
      await Promise.all(Array.from({ length: Math.min(NODES_AT_ONCE, nodes.length) }, worker));
      return { checked: nodes.length, verified };
    } catch (err) {
      this.logger.warn(`Door check did not run: ${(err as Error).message}`);
      return { checked: 0, verified: 0 };
    } finally {
      this.running = false;
    }
  }

  /** Asks for one node's door a little later, without waiting for it.
   * Called as a node comes online, from inside its agent's hello, which
   * must not be held up. */
  learnSoon(nodeId: string, delayMs: number = ONLINE_SETTLE_MS): void {
    if (!nodeDoorsEnabled() || this.settling.has(nodeId)) return;
    const timer = setTimeout(() => {
      this.settling.delete(nodeId);
      void this.learnNode(nodeId);
    }, delayMs);
    // Never the thing keeping the process alive.
    timer.unref();
    this.settling.set(nodeId, timer);
  }

  /** Checks one node now. */
  async learnNode(nodeId: string, now: () => Date = () => new Date()): Promise<boolean> {
    if (!nodeDoorsEnabled()) return false;
    try {
      const node = await this.prisma.node.findFirst({
        where: { id: nodeId, ...ASKED },
        select: NODE_FIELDS,
      });
      return node ? await this.learn(node, now) : false;
    } catch (err) {
      this.logger.warn(`Door check did not run for node ${nodeId}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Tries the node's candidate ports in order and records the first that
   * is a door. Logs only what changed. */
  private async learn(node: LearnedNode, now: () => Date): Promise<boolean> {
    try {
      // A door is an address. A row holding anything else has none.
      if (isIP(node.publicIp) === 0) return false;
      const names = knownNames(node, node.protocolConfigs);
      const domains = doorDomains();
      // No name could be accepted, so nothing is asked.
      if (names.length === 0 && domains.length === 0) return false;
      const sni = doorSni();

      for (const port of candidatePorts(node, node.protocolConfigs, doorPorts())) {
        const probe = await this.prober.probe({
          address: node.publicIp,
          port,
          sni,
          names,
          domains,
        });
        if (!probe.ok) {
          this.logger.debug(`${node.name} port ${port} is not a door: ${probe.reason}`);
          continue;
        }
        const seen = { port, sni, pin: probe.pin };
        // updateMany, so a node deleted meanwhile is nothing rather than
        // an error.
        await this.prisma.node.updateMany({
          where: { id: node.id },
          data: recordSighting(node, seen, now()),
        });
        const change = sightingChange(node, seen) ?? (this.lapsed.has(node.id) ? `door back on port ${port}` : null);
        this.lapsed.delete(node.id);
        if (change) this.logger.log(`${node.name}: ${change}`);
        return true;
      }

      const lastPassed = node.doorVerifiedAt?.getTime();
      if (node.doorPin && lastPassed && now().getTime() - lastPassed > DOOR_FRESH_MS && !this.lapsed.has(node.id)) {
        this.lapsed.add(node.id);
        this.logger.warn(
          `${node.name}: its door is no longer handed out -- no check has passed since ${node.doorVerifiedAt!.toISOString()}`,
        );
      }
      return false;
    } catch (err) {
      // One node's failure must not abandon the rest.
      this.logger.warn(`Door check failed for ${node.name}: ${(err as Error).message}`);
      return false;
    }
  }
}
