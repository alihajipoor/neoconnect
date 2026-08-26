import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import compression from "compression";
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
    // `exposedHeaders` rather than a bare `cors: true`, so a browser can
    // actually read the one header the list routes add. The paged
    // endpoints keep returning a bare JSON array and report how many rows
    // exist in `X-Total-Count` (see common/pagination.ts); by default CORS
    // hides every response header except a short safelist, so without this
    // a cross-origin caller would receive the header and be forbidden from
    // reading it -- and would then have to infer a total from the length of
    // the page it is holding, which is the exact wrong number.
    //
    // Every other CORS default is unchanged from `cors: true`.
    cors: { exposedHeaders: ["X-Total-Count"] },
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

  // gzip, because the largest thing this API serves is the game catalogue
  // and a large share of these customers are on censored Iranian networks
  // where bandwidth is the scarcest thing they have. Measured on the
  // catalogue payload: 374 KB raw, 52 KB gzipped -- a 7x reduction that
  // was sitting unclaimed on exactly the connections that could least
  // afford to pay for it.
  //
  // It belongs here rather than in nginx. There is no nginx config in this
  // repository at all -- infra/docker-compose.prod.yml publishes the
  // backend on 127.0.0.1:4000 and the proxy in front of it is configured
  // on the host by hand -- so a compression rule written there would not
  // survive a rebuild and could not be reviewed. In the app it ships with
  // the code, and it is what a fresh install gets.
  //
  // threshold: anything smaller than this costs more in CPU and in the
  // Content-Encoding round trip than it saves. 1 KB is the library
  // default and is the right call for an API whose small responses are
  // mostly a few hundred bytes of JSON.
  //
  // filter: the default already declines anything marked
  // Content-Encoding, and honours `x-no-compression`. It is kept rather
  // than replaced because the one thing that must NOT be compressed here
  // is the brand logo endpoint (modules/brand/logo.ts), which serves
  // already-compressed PNG bytes -- and compression's default filter
  // declines image/png on its own via mime-db's compressible flag.
  //
  // No BREACH concern in the sense that usually stops people: this API is
  // token-authenticated with a bearer header, not cookie-authenticated,
  // so there is no secret automatically attached to a cross-site request
  // for an attacker to compress alongside chosen plaintext.
  app.use(compression({ threshold: 1024 }));

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
