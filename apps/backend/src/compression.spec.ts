import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import compression from "compression";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { catalogueEntries, toSeedRow } from "../prisma/catalogue";

/** That the API actually compresses, proven over a real socket.
 *
 * The catalogue is by far the largest thing this API serves, and the people
 * it is served to are disproportionately on censored Iranian networks where
 * bandwidth is the scarcest resource they have. Until 2026-08-25 nothing
 * compressed it: there is no compression middleware in main.ts and no nginx
 * config anywhere in this repository, so the 7x reduction was simply not
 * being taken.
 *
 * This asserts over a real HTTP round trip rather than by inspecting the
 * middleware list, because "compression is registered" and "bytes on the
 * wire got smaller" are different claims and only the second one is worth
 * anything. Node does not transparently decompress a response when the
 * request set `Accept-Encoding` by hand, so the byte counts below are the
 * actual compressed octets off the socket.
 *
 * It also pins the two things most likely to regress silently: that a
 * client which did NOT ask for gzip still gets identity (an over-eager
 * middleware breaking an old client is a real failure mode), and that the
 * decompressed body is byte-identical to the uncompressed one. */

/** The real catalogue, shaped the way `profileForCustomer` shapes it. Built
 * from the shipped data rather than from a fixture, because the size of the
 * real payload is the entire point of the measurement. */
function cataloguePayload() {
  const games = catalogueEntries().map((entry, index) => {
    const row = toSeedRow(entry, 1000 + index);
    // Field for field what `profileForCustomer`'s `select` asks for. Kept in
    // step with it deliberately: a payload here that is smaller than the one
    // customers actually receive would understate the saving and make this
    // measurement a comfortable fiction.
    return {
      slug: row.slug,
      displayName: row.displayName,
      iconKey: row.iconKey ?? null,
      publisher: row.publisher ?? null,
      hostnames: row.hostnames,
      excludeHostnames: row.excludeHostnames,
      canaryHostname: row.canaryHostname ?? null,
      processNames: row.processNames,
      destinationCidrs: row.destinationCidrs,
      prefixComplete: row.prefixComplete,
    };
  });
  return { version: 1, entitled: false, unavailableReason: "notEntitled", resolver: null, games };
}

@Controller()
class CatalogueController {
  @Get("catalogue")
  catalogue() {
    return cataloguePayload();
  }

  @Get("small")
  small() {
    return { ok: true };
  }
}

@Module({ controllers: [CatalogueController] })
class TestModule {}

/** One request, returning the bytes as they came off the socket. */
function fetchRaw(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; encoding?: string; bytes: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (c: Buffer) => {
        chunks.push(c);
        bytes += c.length;
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          encoding: res.headers["content-encoding"] as string | undefined,
          bytes,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

describe("response compression", () => {
  let app: NestExpressApplication;
  let port: number;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(TestModule, { logger: false });
    // Exactly what main.ts registers. If that line changes, this should be
    // changed with it and the numbers below re-measured.
    app.use(compression({ threshold: 1024 }));
    await app.listen(0, "127.0.0.1");
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("compresses the catalogue, and by enough to matter", async () => {
    const plain = await fetchRaw(port, "/catalogue", { "accept-encoding": "identity" });
    const gzipped = await fetchRaw(port, "/catalogue", { "accept-encoding": "gzip" });

    expect(plain.status).toBe(200);
    expect(gzipped.status).toBe(200);
    expect(plain.encoding).toBeUndefined();
    expect(gzipped.encoding).toBe("gzip");

    const ratio = plain.bytes / gzipped.bytes;
    // eslint-disable-next-line no-console
    console.log(
      `catalogue on the wire: ${plain.bytes} B identity -> ${gzipped.bytes} B gzip ` +
        `(${ratio.toFixed(1)}x smaller, ${(plain.bytes - gzipped.bytes) / 1024 | 0} KB saved)`,
    );

    // The payload is big enough to be worth compressing at all...
    expect(plain.bytes).toBeGreaterThan(200_000);
    // ...and the saving is real. Deliberately a loose floor: the exact ratio
    // moves with the catalogue's contents, and a test that pinned it would
    // fail on every catalogue regeneration for no reason.
    expect(ratio).toBeGreaterThan(4);
  });

  it("returns the same bytes either way", async () => {
    const plain = await fetchRaw(port, "/catalogue", { "accept-encoding": "identity" });
    const gzipped = await fetchRaw(port, "/catalogue", { "accept-encoding": "gzip" });
    const inflated = (await import("node:zlib")).gunzipSync(gzipped.body);
    expect(inflated.equals(plain.body)).toBe(true);
  });

  it("leaves a client that did not ask for gzip alone", async () => {
    // An over-eager middleware handing gzip to a client that cannot read it
    // is a worse bug than no compression at all.
    const res = await fetchRaw(port, "/catalogue", { "accept-encoding": "identity" });
    expect(res.encoding).toBeUndefined();
    expect(() => JSON.parse(res.body.toString("utf8"))).not.toThrow();
  });

  it("does not bother with a response below the threshold", async () => {
    // Below 1 KB the Content-Encoding round trip costs more than it saves.
    const res = await fetchRaw(port, "/small", { "accept-encoding": "gzip" });
    expect(res.encoding).toBeUndefined();
    expect(JSON.parse(res.body.toString("utf8"))).toEqual({ ok: true });
  });
});
