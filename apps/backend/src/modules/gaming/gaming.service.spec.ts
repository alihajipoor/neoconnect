import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PlanFeatureKey, SubscriptionStatus } from "@prisma/client";
import { GamingService } from "./gaming.service";

/** These tests exist to pin down the ways this feature could lie to a
 * customer, not to exercise CRUD.
 *
 * The rule they enforce, from CLAUDE.md: never report a state the app has not
 * verified. On the backend that reduces to one thing -- a client is handed a
 * resolver only when a node has actually confirmed it is serving one, and
 * never merely because an operator ticked a box. */
describe("GamingService", () => {
  // Typed mock shape rather than `any`, matching plans.service.spec.ts. The
  // spec-file lint override relaxes no-unsafe-assignment and friends but not
  // no-unsafe-call, so calling `.mockResolvedValue` on an `any` is an error.
  type Table = Record<string, jest.Mock>;
  let prisma: {
    gameProfile: Table;
    gamingResolver: Table;
    gamingResolverToken: Table;
    subscription: Table;
    subscriptionPlan: Table;
    planFeature: Table;
    node: Table;
    $transaction: jest.Mock;
  };
  let service: GamingService;

  const RESOLVER = {
    id: "resolver-1",
    dohHost: "cdn-edge.example.net",
    dohPort: 443,
    proxyIp: "203.0.113.10",
    proxyPort: 443,
    confirmedAt: new Date(),
    node: { region: "de" },
  };

  const GAME = {
    slug: "wow",
    displayName: "World of Warcraft",
    iconKey: "wow",
    publisher: "Blizzard Entertainment",
    hostnames: ["oauth.battle.net"],
    excludeHostnames: ["blzddist1-a.akamaihd.net"],
    canaryHostname: "oauth.battle.net",
  };

  function subscriptionGranting(...features: PlanFeatureKey[]) {
    return [{ plan: { features: features.map((feature) => ({ feature })) } }];
  }

  beforeEach(() => {
    prisma = {
      gameProfile: {
        findMany: jest.fn().mockResolvedValue([GAME]),
        findUnique: jest.fn(),
        create: jest.fn((args: any) => Promise.resolve(args.data)),
        update: jest.fn((args: any) => Promise.resolve(args.data)),
        delete: jest.fn(),
      },
      gamingResolver: {
        findFirst: jest.fn().mockResolvedValue(RESOLVER),
        findUnique: jest.fn(),
        create: jest.fn((args: any) => Promise.resolve(args.data)),
        update: jest.fn((args: any) => Promise.resolve(args.data)),
        delete: jest.fn(),
      },
      gamingResolverToken: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
      },
      subscription: {
        findMany: jest.fn().mockResolvedValue(subscriptionGranting(PlanFeatureKey.GAMING_DNS)),
      },
      subscriptionPlan: { findMany: jest.fn(), findUnique: jest.fn() },
      planFeature: {
        deleteMany: jest.fn().mockReturnValue({ op: "deleteMany" }),
        createMany: jest.fn().mockReturnValue({ op: "createMany" }),
      },
      node: { findUnique: jest.fn() },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    service = new GamingService(prisma as any);
  });

  describe("profileForCustomer", () => {
    it("hands over a resolver when the plan grants it and a node has confirmed", async () => {
      const payload = await service.profileForCustomer("customer-1");

      expect(payload.entitled).toBe(true);
      expect(payload.unavailableReason).toBeNull();
      expect(payload.resolver).not.toBeNull();
      expect(payload.resolver?.proxyIp).toBe("203.0.113.10");
      expect(payload.resolver?.nodeRegion).toBe("de");
    });

    it("only ever considers resolvers that are enabled AND recently confirmed", async () => {
      await service.profileForCustomer("customer-1");

      const where = prisma.gamingResolver.findFirst.mock.calls[0][0].where;
      expect(where.isEnabled).toBe(true);
      // The important half: an operator switching a resolver on is not
      // sufficient. Without this clause a client would be told to use a node
      // that has never reported serving anything.
      expect(where.confirmedAt.not).toBeNull();
      expect(where.confirmedAt.gte).toBeInstanceOf(Date);
    });

    it("says noResolver -- not a network error -- when no node is serving one", async () => {
      prisma.gamingResolver.findFirst.mockResolvedValue(null);

      const payload = await service.profileForCustomer("customer-1");

      expect(payload.entitled).toBe(true);
      expect(payload.unavailableReason).toBe("noResolver");
      expect(payload.resolver).toBeNull();
      // The catalogue still travels so the app can explain itself rather
      // than render an empty screen that reads as a fault.
      expect(payload.games).toHaveLength(1);
    });

    it("says noSubscription when nothing is live", async () => {
      prisma.subscription.findMany.mockResolvedValue([]);

      const payload = await service.profileForCustomer("customer-1");

      expect(payload.unavailableReason).toBe("noSubscription");
      expect(payload.entitled).toBe(false);
      expect(payload.resolver).toBeNull();
    });

    it("says notEntitled when the plan grants no gaming feature", async () => {
      prisma.subscription.findMany.mockResolvedValue(subscriptionGranting());

      const payload = await service.profileForCustomer("customer-1");

      expect(payload.unavailableReason).toBe("notEntitled");
      expect(payload.resolver).toBeNull();
    });

    it("does not treat the unbuilt private exit as an entitlement", async () => {
      // A plan granting ONLY the private exit grants nothing usable, because
      // no code implements it. Reporting otherwise would put an option in
      // front of a customer that cannot do anything.
      prisma.subscription.findMany.mockResolvedValue(
        subscriptionGranting(PlanFeatureKey.GAMING_PRIVATE_EXIT),
      );

      const payload = await service.profileForCustomer("customer-1");

      expect(payload.unavailableReason).toBe("notEntitled");
    });

    it("never tells the client about GAMING_PRIVATE_EXIT even when granted", async () => {
      prisma.subscription.findMany.mockResolvedValue(
        subscriptionGranting(PlanFeatureKey.GAMING_DNS, PlanFeatureKey.GAMING_PRIVATE_EXIT),
      );

      const payload = await service.profileForCustomer("customer-1");

      expect(JSON.stringify(payload)).not.toContain("PRIVATE_EXIT");
    });

    it("counts only ACTIVE, unexpired subscriptions", async () => {
      await service.profileForCustomer("customer-1");

      const where = prisma.subscription.findMany.mock.calls[0][0].where;
      expect(where.status.in).toEqual([SubscriptionStatus.ACTIVE]);
      expect(where.expireAt.gt).toBeInstanceOf(Date);
    });

    it("reuses an existing token rather than rotating it on every call", async () => {
      // Rotating per call would silently cut off whichever of the customer's
      // devices asked second.
      prisma.gamingResolverToken.findUnique.mockResolvedValue({
        token: "already-issued",
        revokedAt: null,
      });

      const payload = await service.profileForCustomer("customer-1");

      expect(payload.resolver?.dohUrl).toContain("already-issued");
      expect(prisma.gamingResolverToken.upsert).not.toHaveBeenCalled();
    });

    it("mints a fresh token when the old one was revoked", async () => {
      prisma.gamingResolverToken.findUnique.mockResolvedValue({
        token: "leaked",
        revokedAt: new Date(),
      });

      const payload = await service.profileForCustomer("customer-1");

      expect(prisma.gamingResolverToken.upsert).toHaveBeenCalled();
      expect(payload.resolver?.dohUrl).not.toContain("leaked");
    });

    it("only offers active games", async () => {
      await service.profileForCustomer("customer-1");
      expect(prisma.gameProfile.findMany.mock.calls[0][0].where).toEqual({ isActive: true });
    });
  });

  describe("profile coherence", () => {
    it("refuses a canary that is not one of the redirected hostnames", async () => {
      // A canary that is not redirected resolves truthfully, so it can never
      // prove the rules are live -- and a client that cannot prove it can
      // never truthfully say more than "partial".
      await expect(
        service.createProfile({
          slug: "wow",
          displayName: "World of Warcraft",
          hostnames: ["oauth.battle.net"],
          canaryHostname: "example.com",
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses a hostname that is in both the redirect and exclude lists", async () => {
      await expect(
        service.createProfile({
          slug: "wow",
          displayName: "World of Warcraft",
          hostnames: ["oauth.battle.net"],
          excludeHostnames: ["oauth.battle.net"],
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("normalises hostnames so downstream comparisons cannot disagree", async () => {
      const created: any = await service.createProfile({
        slug: "wow",
        displayName: "World of Warcraft",
        hostnames: ["OAuth.Battle.NET", "oauth.battle.net.", " oauth.battle.net "],
        canaryHostname: "OAUTH.BATTLE.NET",
      } as any);

      expect(created.hostnames).toEqual(["oauth.battle.net"]);
      expect(created.canaryHostname).toBe("oauth.battle.net");
    });

    it("re-checks the canary against the row as it will be after a PATCH", async () => {
      // Editing only `hostnames` can strand a canary set by an earlier
      // request. Validating the DTO alone would let that through.
      prisma.gameProfile.findUnique.mockResolvedValue({
        ...GAME,
        id: "p1",
        hostnames: ["oauth.battle.net"],
        canaryHostname: "oauth.battle.net",
      });

      await expect(
        service.updateProfile("p1", { hostnames: ["account.battle.net"] } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("resolvers", () => {
    it("drops a node's confirmation when the endpoint it confirmed is changed", async () => {
      prisma.gamingResolver.findUnique.mockResolvedValue({
        ...RESOLVER,
        nodeId: "node-1",
      });

      await service.updateResolver("resolver-1", { proxyIp: "198.51.100.7" } as any);

      const data = prisma.gamingResolver.update.mock.calls[0][0].data;
      expect(data.confirmedAt).toBeNull();
      expect(data.lastError).toBeNull();
    });

    it("keeps the confirmation when only the enabled flag moves", async () => {
      prisma.gamingResolver.findUnique.mockResolvedValue({
        ...RESOLVER,
        nodeId: "node-1",
      });

      await service.updateResolver("resolver-1", { isEnabled: true } as any);

      const data = prisma.gamingResolver.update.mock.calls[0][0].data;
      expect(data.confirmedAt).toBeUndefined();
    });

    it("refuses a second resolver on the same node", async () => {
      prisma.node.findUnique.mockResolvedValue({ id: "node-1", name: "germany-1" });
      prisma.gamingResolver.findUnique.mockResolvedValue({ id: "existing" });

      await expect(
        service.createResolver({
          nodeId: "node-1",
          dohHost: "edge.example.net",
          proxyIp: "203.0.113.10",
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses a resolver on a node that does not exist", async () => {
      prisma.node.findUnique.mockResolvedValue(null);

      await expect(
        service.createResolver({
          nodeId: "nope",
          dohHost: "edge.example.net",
          proxyIp: "203.0.113.10",
        } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("creates a resolver switched off, whatever else was asked for", async () => {
      prisma.node.findUnique.mockResolvedValue({ id: "node-1", name: "germany-1" });
      prisma.gamingResolver.findUnique.mockResolvedValue(null);

      const created: any = await service.createResolver({
        nodeId: "node-1",
        dohHost: "Edge.Example.NET",
        proxyIp: "203.0.113.10",
      } as any);

      expect(created.isEnabled).toBe(false);
      expect(created.dohHost).toBe("edge.example.net");
    });
  });

  describe("plan features", () => {
    it("replaces the whole set so deselecting actually revokes", async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue({ id: "plan-1", name: "Pro" });

      await service.setPlanFeatures("plan-1", []);

      expect(prisma.$transaction).toHaveBeenCalled();
      const [del, create] = prisma.$transaction.mock.calls[0][0];
      expect(del).toBeDefined();
      expect(create).toBeDefined();
      expect(prisma.planFeature.deleteMany).toHaveBeenCalledWith({ where: { planId: "plan-1" } });
      expect(prisma.planFeature.createMany).toHaveBeenCalledWith({ data: [] });
    });

    it("refuses an unknown plan", async () => {
      prisma.subscriptionPlan.findUnique.mockResolvedValue(null);

      await expect(service.setPlanFeatures("nope", [])).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
