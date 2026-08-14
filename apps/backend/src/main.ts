import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { AppModule } from "./app.module";

// Prisma returns BigInt for our byte-counter columns (dataCapBytes,
// dataUsedBytes, usage deltas); Express's default JSON.stringify throws on
// BigInt with no override. Serialize as a decimal string everywhere instead
// of forcing every service method to convert it by hand.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (this: bigint) {
  return this.toString();
};

async function bootstrap() {
  // rawBody: true preserves req.rawBody alongside the normal parsed
  // req.body on every request -- needed for Stripe webhook signature
  // verification, which must hash the exact bytes Stripe sent, not a
  // JSON.stringify of the re-parsed object (whitespace/key-order would
  // change the hash). Every other route is unaffected.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    cors: true,
    rawBody: true,
  });

  // Trust exactly one proxy hop, so req.ip is the real client rather than
  // nginx's 127.0.0.1.
  //
  // Without this every @Throttle in the app shares ONE bucket. Measured in
  // production on 2026-08-12, before the fix: three requests carrying three
  // different X-Forwarded-For values returned X-RateLimit-Remaining 18, 17,
  // 16 -- one counter, not three. That made the 5/60s login limit a global
  // 5 attempts per minute across every customer, so a single script from a
  // single address could lock the whole user base (and the admin) out of
  // signing in. It also meant the limits gave no real per-attacker
  // protection, which is the thing they exist for.
  //
  // Exactly 1, not `true`: nginx sets X-Forwarded-For with
  // $proxy_add_x_forwarded_for, which APPENDS the real peer to whatever the
  // client sent, so the last entry is trustworthy and everything to its left
  // is attacker-controlled. Trusting one hop takes that last entry. `true`
  // would trust the whole chain and let a client spoof its own address --
  // handing out a fresh rate-limit budget per forged header, which is worse
  // than the bug being fixed.
  //
  // Safe because the backend is published as 127.0.0.1:4000 in
  // infra/docker-compose.prod.yml, so nginx is the only way in and the hop
  // count is always exactly one.
  app.set("trust proxy", 1);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Swagger UI, off in production.
  //
  // It was on, and reachable unauthenticated at
  // connect.neoxify.site/api/docs -- confirmed by opening it on
  // 2026-08-14. It is a complete map of the control plane: every admin
  // route, every DTO, every required field, including the ones that
  // provision credentials and delete routes. None of that is a
  // vulnerability by itself and none of it is secret in a public repo,
  // but handing an attacker the index saves them the only slow part of
  // finding the endpoints worth trying, and the customers this serves
  // are worth the two lines.
  //
  // ENABLE_API_DOCS=true turns it back on deliberately, for a box where
  // someone wants it. Opt-in rather than opt-out: an unset variable on a
  // new deployment should mean closed.
  const docsEnabled =
    process.env.ENABLE_API_DOCS === "true" || process.env.NODE_ENV !== "production";
  if (docsEnabled) {
    const config = new DocumentBuilder()
      .setTitle("Neoxify Control Plane API")
      .setDescription("Admin panel + agent orchestration backend")
      .setVersion("0.1.0")
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup("docs", app, document);
  }

  const port = process.env.PORT ? Number(process.env.PORT) : 4000;
  await app.listen(port);
  console.log(`Neoxify backend listening on port ${port}`);
}

void bootstrap();
