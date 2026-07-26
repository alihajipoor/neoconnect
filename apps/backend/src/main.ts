import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
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
  const app = await NestFactory.create(AppModule, { cors: true, rawBody: true });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle("Neoxify Control Plane API")
    .setDescription("Admin panel + agent orchestration backend")
    .setVersion("0.1.0")
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("docs", app, document);

  const port = process.env.PORT ? Number(process.env.PORT) : 4000;
  await app.listen(port);
  console.log(`Neoxify backend listening on port ${port}`);
}

void bootstrap();
