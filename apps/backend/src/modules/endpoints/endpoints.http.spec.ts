/* eslint-disable @typescript-eslint/require-await -- the Prisma stand-in
   matches the client's async signatures. */
import { Logger, ValidationPipe, type ExecutionContext, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createHash } from "node:crypto";
import type { AddressInfo, Server } from "node:net";
import { PrismaService } from "../../prisma/prisma.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AdminEndpointsController } from "./endpoints.controller";
import { EndpointsService } from "./endpoints.service";

/** The panel-bases route over a real Nest server, with the validation
 * pipe production uses.
 *
 * What only this level can show: the route has no validating DTO, and
 * the global pipe runs with whitelist and forbidNonWhitelisted, which
 * turn away any field a DTO class does not declare. A body class added
 * later for the old shape would stop `kind` and `pins` before the
 * service saw them. Here they are shown arriving intact, the entry being
 * drafted as lastResort, and a refusal reaching the operator as a 400
 * with its reason. Postgres is a stand-in holding one row. */

const PIN = `sha256/${createHash("sha256").update("relay").digest("base64")}`;

describe("admin endpoints over HTTP", () => {
  let app: INestApplication;
  let base: string;
  const row = { id: "s1", panelBasesJson: "[]", signed: null as string | null, version: 0 };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const prisma = {
      endpointBundleState: {
        findFirst: jest.fn(async () => ({ ...row })),
        create: jest.fn(async () => ({ ...row })),
        update: jest.fn(async ({ data }: { data: Partial<typeof row> }) => Object.assign(row, data)),
      },
      node: {
        findMany: jest.fn(async () => [
          { name: "finland1", region: "fi-finland", mirrorHost: "aaa111.example.net" },
        ]),
      },
    };

    const module = await Test.createTestingModule({
      controllers: [AdminEndpointsController],
      providers: [EndpointsService, { provide: PrismaService, useValue: prisma }],
    })
      // A SUPERADMIN without signing a JWT; RolesGuard is the real one.
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest<{ user?: unknown }>().user = { sub: "admin-1", role: "SUPERADMIN" };
          return true;
        },
      })
      .compile();

    app = module.createNestApplication();
    // As main.ts configures it.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    await app.listen(0);
    base = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  const postBases = (entries: unknown) =>
    fetch(`${base}/admin/endpoints/panel-bases`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries }),
    });

  it("carries a lastResort entry through the pipe and drafts it last", async () => {
    const saved = await postBases([
      { kind: "lastResort", url: "https://192.0.2.10/api", pins: [PIN] },
      // The shape from before lastResort, without kind.
      { url: "https://panel.example.com/api" },
    ]);
    expect(saved.status).toBe(201);

    const draft = await fetch(`${base}/admin/endpoints/draft`);
    expect(draft.status).toBe(200);
    const body = (await draft.json()) as { endpoints: unknown[] };
    expect(body.endpoints).toEqual([
      { kind: "panel", url: "https://panel.example.com/api" },
      { kind: "mirror", url: "https://aaa111.example.net:2053/api", region: "fi" },
      { kind: "lastResort", url: "https://192.0.2.10/api", pins: [PIN] },
    ]);
  });

  it("answers an IP-addressed panel base with a 400 that says why", async () => {
    const before = row.panelBasesJson;
    const refused = await postBases([{ url: "https://198.51.100.7/api" }]);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { message: string }).message).toMatch(
      /^entries\[0\]: url must name a DNS host, not an IP address/,
    );
    expect(row.panelBasesJson).toBe(before);
  });

  it("answers a malformed pin with a 400 that says why", async () => {
    const refused = await postBases([{ kind: "lastResort", url: "https://192.0.2.10/api", pins: ["sha256/short"] }]);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { message: string }).message).toBe(
      'entries[0]: pins[0] must have exactly 44 base64 characters after "sha256/", not 5',
    );
  });
});
