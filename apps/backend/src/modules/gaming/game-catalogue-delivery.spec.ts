import type { INestApplication } from "@nestjs/common";
import { Controller, Get, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PlanFeatureKey, SubscriptionStatus } from "@prisma/client";
import type { AddressInfo, Server } from "node:net";
import { gzipSync } from "node:zlib";

import { catalogueEntries, toSeedRow } from "../../../prisma/catalogue";
import { GamingService } from "./gaming.service";
import { PrismaService } from "../../prisma/prisma.service";

/** Does the catalogue actually reach a client, over HTTP, intact?
 *
 * This is the test that exists because of a specific past failure: the
 * database rows carried `processNames`, and the endpoint's `select` did not
 * name the column, so the field was dropped somewhere in the middle and
 * nothing anywhere reported it. Every layer looked fine on its own. A
 * unit test of the service would not have caught it, because the service was
 * the layer that was wrong.
 *
 * So this drives the real thing end to end: rows built by the real
 * `toSeedRow` from the real shipped catalogue, through the real
 * `GamingService.profileForCustomer`, out of a real listening Nest server,
 * and back through `fetch` -- and then asserts on the parsed JSON a client
 * would actually receive.
 *
 * WHAT IS STILL NOT PROVEN, stated because it matters: there is no Postgres
 * here. The Prisma stand-in below stores the seed rows and applies `select`
 * the way Prisma does, which pins the shape and the projection, but the
 * `text[]` round trip through the database itself is not exercised. And
 * nothing here has been run against an actual game -- a catalogue entry
 * means "we will route these executables if they are running", nothing more.
 */

/** Applies a Prisma `select` to a row, which is the behaviour this test
 * depends on being faithful: a column the endpoint forgets to name must
 * come back absent, exactly as it would from the real client. */
function project<T extends Record<string, unknown>>(row: T, select: Record<string, boolean>) {
  const out: Record<string, unknown> = {};
  for (const [key, wanted] of Object.entries(select)) {
    if (wanted) out[key] = row[key];
  }
  return out;
}

describe("game catalogue delivery", () => {
  let app: INestApplication;
  let baseUrl: string;
  const rows = catalogueEntries().map((entry, i) => toSeedRow(entry, 1000 + i));

  beforeAll(async () => {
    const prisma = {
      gameProfile: {
        findMany: jest.fn(({ where, orderBy, select }) => {
          const active = rows.filter((r) => (where?.isActive === undefined ? true : r.isActive));
          const sorted = [...active].sort((a, b) => {
            void orderBy;
            return a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName);
          });
          return Promise.resolve(sorted.map((r) => project(r, select)));
        }),
      },
      // Entitled, with a confirmed resolver, so the full payload is exercised
      // rather than the short unavailable branch.
      subscription: {
        findMany: jest.fn().mockResolvedValue([
          { plan: { features: [{ feature: PlanFeatureKey.GAMING_DNS }] } },
        ]),
        findFirst: jest.fn().mockResolvedValue({ status: SubscriptionStatus.ACTIVE }),
      },
      gamingResolver: {
        findFirst: jest.fn().mockResolvedValue({
          id: "resolver-1",
          dohHost: "resolver.example.net",
          dohPort: 443,
          proxyIp: "198.51.100.10",
          proxyPort: 443,
          confirmedAt: new Date(),
          node: { region: "de" },
        }),
      },
      gamingResolverToken: {
        findUnique: jest.fn().mockResolvedValue({ token: "test-token", revokedAt: null }),
        upsert: jest.fn().mockResolvedValue({ token: "test-token" }),
      },
    };

    @Controller("customer")
    class TestCustomerController {
      constructor(private readonly gaming: GamingService) {}
      // Same route and same call the real CustomerController makes; the
      // guards it carries are about who may ask, not about what comes back.
      @Get("gaming-profile")
      gamingProfile() {
        return this.gaming.profileForCustomer("customer-1");
      }
    }

    @Module({
      controllers: [TestCustomerController],
      providers: [GamingService, { provide: PrismaService, useValue: prisma }],
    })
    class TestModule {}

    app = (await Test.createTestingModule({ imports: [TestModule] }).compile()).createNestApplication();
    await app.init();
    await app.listen(0);
    const server = app.getHttpServer() as Server;
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it("delivers every active catalogue entry with its process names intact", async () => {
    const res = await fetch(`${baseUrl}/customer/gaming-profile`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      games: { slug: string; displayName: string; processNames?: string[] }[];
    };

    expect(body.games).toHaveLength(rows.length);

    // The regression itself: the field must survive the select, the
    // serializer and the wire.
    const withNames = body.games.filter((g) => (g.processNames?.length ?? 0) > 0);
    expect(withNames).toHaveLength(rows.length);

    // And a specific, verifiable entry rather than only an aggregate -- an
    // aggregate can pass while every individual name is wrong.
    const overwatch = body.games.find((g) => g.slug === "overwatch");
    expect(overwatch?.processNames).toContain("Overwatch.exe");
    // A name with a space in it, because that is the case a whitespace-split
    // storage format would silently mangle.
    expect(overwatch?.processNames).toContain("Overwatch Launcher.exe");

    const battleye = body.games.find((g) => g.slug === "battleye-anti-cheat");
    expect(battleye?.processNames).toEqual(["BEService.exe", "BEService_x64.exe"]);
  });

  it("never ships a prefix claim to a client", async () => {
    const res = await fetch(`${baseUrl}/customer/gaming-profile`);
    const body = (await res.json()) as {
      games: { slug: string; prefixComplete?: boolean; destinationCidrs?: string[] }[];
    };
    // The client refuses destination routing while `prefixComplete` is
    // false, and an incomplete list marked whole is the account-sharing
    // signature. Asserted on the wire, which is the only place it counts.
    for (const game of body.games) {
      expect(game.prefixComplete).toBe(false);
      expect(game.destinationCidrs).toEqual([]);
    }
  });

  it("reports what the full catalogue costs to deliver", async () => {
    const res = await fetch(`${baseUrl}/customer/gaming-profile`);
    const text = await res.text();
    const raw = Buffer.byteLength(text, "utf8");
    const gz = gzipSync(Buffer.from(text, "utf8"), { level: 6 }).length;

    // Not a performance assertion so much as a tripwire with a number
    // attached. The catalogue is data and data grows; if somebody doubles it
    // this fails and they get to make the pagination decision on purpose
    // rather than discover it from a customer in Iran on a throttled link.
    //
    // Measured 2026-08-25: 1483 games, 375482 bytes raw, 52151 gzipped.
    // NOTE: nothing in this repo actually gzips it -- there is no
    // compression middleware in main.ts -- so the raw figure is what ships
    // unless the reverse proxy is doing it.
    console.log(`gaming-profile payload: ${raw} bytes raw, ${gz} bytes gzip -6`);
    expect(raw).toBeLessThan(600_000);
  });
});
