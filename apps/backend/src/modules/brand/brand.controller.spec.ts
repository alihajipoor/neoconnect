import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { BrandController } from "./brand.controller";
import { EMAIL_LOGO_FILES, EMAIL_LOGOS } from "./email-logo";

/** Over real HTTP, because the consumer is a mail client fetching an
 * <img>: what matters is the status, the type and the bytes it gets
 * back, not what a method returns. */
describe("BrandController", () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [BrandController] }).compile();
    app = module.createNestApplication();
    await app.listen(0, "127.0.0.1");
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it("serves each email logo as the PNG that was rendered", async () => {
    for (const file of EMAIL_LOGO_FILES) {
      const res = await fetch(`${base}/brand/${file}`);
      expect(`${file}:${res.status}`).toBe(`${file}:200`);
      expect(res.headers.get("content-type")).toContain("image/png");
      expect(res.headers.get("cache-control")).toBe("public, max-age=2592000");
      expect(Buffer.from(await res.arrayBuffer()).equals(EMAIL_LOGOS[file])).toBe(true);
    }
  });

  it("still serves the logo that mail already sent asks for", async () => {
    // Old emails in people's inboxes point at this address and are never
    // re-sent, so it has to keep answering.
    const res = await fetch(`${base}/brand/logo-mono.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
  });

  it("does not serve a file that is not one of them", async () => {
    const res = await fetch(`${base}/brand/email-logo-other.png`);
    expect(res.status).toBe(404);
  });
});
