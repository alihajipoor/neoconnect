import { Decimal } from "@prisma/client/runtime/library";

import { IntegrationsService } from "./integrations.service";
import { PrismaService } from "../../prisma/prisma.service";
import { PlansService } from "../plans/plans.service";
import { UpdatesService } from "../updates/updates.service";

const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000);

describe("IntegrationsService", () => {
  const build = ({
    nodes = [] as unknown[],
    routes = [] as unknown[],
    plans = [] as unknown[],
    installerUrl = () => Promise.resolve("https://neoxify.net/download/NeoxifySetup.exe"),
    releaseSummary = () =>
      Promise.resolve([
        { platform: "windows", version: "0.8.7", url: "https://gh/win.exe", publishedAt: "2026-08-04T00:00:00Z" },
        { platform: "android", version: "0.2.1", url: "https://gh/app.apk", publishedAt: null },
      ]),
  } = {}) =>
    new IntegrationsService(
      {
        node: { findMany: jest.fn().mockResolvedValue(nodes) },
        route: { findMany: jest.fn().mockResolvedValue(routes) },
      } as unknown as PrismaService,
      { listActive: jest.fn().mockResolvedValue(plans) } as unknown as PlansService,
      { installerUrl, releaseSummary } as unknown as UpdatesService,
    );

  describe("status", () => {
    it("counts a node with a recent heartbeat as online", async () => {
      const service = build({
        nodes: [{ region: "de", status: "ONLINE", lastHeartbeatAt: minutesAgo(1) }],
      });
      const status = await service.status();
      expect(status.nodes).toMatchObject({ total: 1, online: 1, stale: 0 });
    });

    /** The heartbeat sweep flips the column eventually. Until it does, a node
     *  that stopped reporting still says ONLINE -- reporting that verbatim
     *  would tell members everything is fine during an outage. */
    it("treats a silent ONLINE node as stale, not online", async () => {
      const service = build({
        nodes: [{ region: "de", status: "ONLINE", lastHeartbeatAt: minutesAgo(30) }],
      });
      const status = await service.status();
      expect(status.nodes).toMatchObject({ total: 1, online: 0, stale: 1 });
    });

    it("treats a node that has never reported as stale", async () => {
      const service = build({ nodes: [{ region: "de", status: "ONLINE", lastHeartbeatAt: null }] });
      expect((await service.status()).nodes.stale).toBe(1);
    });

    it("counts OFFLINE and DISABLED nodes as offline", async () => {
      const service = build({
        nodes: [
          { region: "de", status: "OFFLINE", lastHeartbeatAt: null },
          { region: "de", status: "DISABLED", lastHeartbeatAt: null },
          { region: "de", status: "PENDING", lastHeartbeatAt: null },
        ],
      });
      const status = await service.status();
      expect(status.nodes).toMatchObject({ total: 3, online: 0, offline: 2 });
    });

    it("groups by region, sorted, with per-region online counts", async () => {
      const service = build({
        nodes: [
          { region: "nl", status: "ONLINE", lastHeartbeatAt: minutesAgo(1) },
          { region: "de", status: "ONLINE", lastHeartbeatAt: minutesAgo(1) },
          { region: "de", status: "OFFLINE", lastHeartbeatAt: null },
        ],
      });
      expect((await service.status()).regions).toEqual([
        { region: "de", online: 1, total: 2 },
        { region: "nl", online: 1, total: 1 },
      ]);
    });

    it("counts enabled routes separately from total", async () => {
      const service = build({ routes: [{ isEnabled: true }, { isEnabled: false }] });
      expect((await service.status()).routes).toEqual({ total: 2, enabled: 1 });
    });

    /** Nothing identifying may reach a public Discord channel. */
    it("never selects a node's address", async () => {
      const service = build();
      const prisma = (service as unknown as { prisma: { node: { findMany: jest.Mock } } }).prisma;
      await service.status();
      const select = prisma.node.findMany.mock.calls[0][0].select;
      expect(select.publicIp).toBeUndefined();
      expect(select.agentPubKey).toBeUndefined();
      expect(select).toEqual({ region: true, status: true, lastHeartbeatAt: true });
    });
  });

  describe("publicPlans", () => {
    const plan = {
      name: "Pro",
      priceUsd: new Decimal("9.99"),
      durationDays: 30,
      dataCapBytes: BigInt(100) * BigInt(1024) ** BigInt(3),
      maxDownloadMbps: 200,
      maxUploadMbps: null,
      maxConcurrentConnections: 3,
    };

    /** Decimal and BigInt both break JSON.stringify. Converting at the edge
     *  is the difference between a working endpoint and a 500. */
    it("serialises Decimal and BigInt into JSON-safe values", async () => {
      const [result] = await build({ plans: [plan] }).publicPlans();
      expect(result.priceUsd).toBe("9.99");
      expect(result.dataCapGb).toBe(100);
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it("keeps an unlimited plan's cap as null rather than zero", async () => {
      const [result] = await build({ plans: [{ ...plan, dataCapBytes: null }] }).publicPlans();
      expect(result.dataCapGb).toBeNull();
    });

    it("passes speed caps through, null when uncapped", async () => {
      const [result] = await build({ plans: [plan] }).publicPlans();
      expect(result.maxDownloadMbps).toBe(200);
      expect(result.maxUploadMbps).toBeNull();
    });
  });

  describe("releases", () => {
    it("returns every platform's newest build", async () => {
      const releases = await build().releases();
      expect(releases.map((r) => r.platform)).toEqual(["windows", "android"]);
      expect(releases[0]).toMatchObject({ version: "0.8.7", url: "https://gh/win.exe" });
    });

    /** This feeds a panel the bot rewrites in a public channel. A thrown
     *  error there would be a broken post seen by every member, so an empty
     *  list -- which the panel renders as "check the website" -- is the
     *  better failure. */
    it("degrades to an empty list rather than throwing", async () => {
      const service = build({
        releaseSummary: () => Promise.reject(new Error("GitHub is down")),
      });
      await expect(service.releases()).resolves.toEqual([]);
    });
  });

  describe("download", () => {
    it("returns the installer url", async () => {
      expect(await build().download()).toEqual({
        installerUrl: "https://neoxify.net/download/NeoxifySetup.exe",
      });
    });

    /** The updates feed is upstream. A bot reply of "get it from the site"
     *  is better than a 500 in a support channel. */
    it("degrades to null when the updates feed is unavailable", async () => {
      const service = build({
        installerUrl: () => Promise.reject(new Error("GitHub is down")),
      });
      await expect(service.download()).resolves.toEqual({ installerUrl: null });
    });
  });
});
