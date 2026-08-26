import { HttpStatus } from "@nestjs/common";
import type { Request, Response } from "express";
import { CustomerController } from "./customer.controller";

/** `GET /customer/gaming-profile` is the route that genuinely has to
 * return everything.
 *
 * The desktop client resolves catalogue names against the processes
 * running on the machine with no network in the loop, so it needs the
 * whole catalogue -- a page of one is not a smaller answer, it is a
 * silently wrong one for every game past the boundary. That rules out a
 * `take`, so the bound is revalidation instead: an unchanged catalogue
 * costs a 304 with no body rather than 373,954 B (51,742 B gzipped,
 * measured on the wire).
 *
 * These tests pin the two things that make it safe. The tag has to move
 * when the answer moves -- including on the per-customer half, or a
 * customer whose plan just started keeps being served "not entitled" --
 * and a caller that sends no validator has to keep getting its body,
 * because every client in the field today is exactly that caller. */
describe("GET /customer/gaming-profile revalidation", () => {
  const CUSTOMER = { sub: "customer-1" } as any;
  const PAYLOAD = { version: 1, entitled: true, unavailableReason: null, resolver: null, games: [] };

  let gaming: { catalogueFingerprint: jest.Mock; profileForCustomer: jest.Mock };
  let controller: CustomerController;
  let headers: Record<string, string>;
  let status: number | null;
  let res: Response;

  function requestWith(ifNoneMatch?: string): Request {
    return { headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : {} } as unknown as Request;
  }

  beforeEach(() => {
    gaming = {
      catalogueFingerprint: jest.fn().mockResolvedValue("1480:1756000000000"),
      profileForCustomer: jest.fn().mockResolvedValue(PAYLOAD),
    };
    headers = {};
    status = null;
    res = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
      },
      status: (code: number) => {
        status = code;
        return res;
      },
    } as unknown as Response;

    // Only the gaming service is exercised by this handler; the other
    // thirteen dependencies are never touched on this path.
    const deps = [...new Array(13).fill(undefined), gaming] as unknown as ConstructorParameters<
      typeof CustomerController
    >;
    controller = new CustomerController(...deps);
  });

  it("serves the full payload, and a validator, when the caller sends none", async () => {
    const body = await controller.gamingProfile(CUSTOMER, requestWith(), res);

    expect(body).toBe(PAYLOAD);
    expect(status).toBeNull();
    expect(headers.ETag).toMatch(/^W\/"gaming-/);
  });

  /** The saving. Note what is asserted: not merely a 304, but that the
   * catalogue was never read. Returning a 304 after building the payload
   * would save the wire and none of the work. */
  it("answers 304 without reading the catalogue when nothing has changed", async () => {
    const first = await controller.gamingProfile(CUSTOMER, requestWith(), res);
    expect(first).toBe(PAYLOAD);

    gaming.profileForCustomer.mockClear();
    const body = await controller.gamingProfile(CUSTOMER, requestWith(headers.ETag), res);

    expect(status).toBe(HttpStatus.NOT_MODIFIED);
    expect(body).toBeUndefined();
    expect(gaming.profileForCustomer).not.toHaveBeenCalled();
  });

  it("serves the payload again once the catalogue changes", async () => {
    await controller.gamingProfile(CUSTOMER, requestWith(), res);
    const stale = headers.ETag;

    // One profile edited: the aggregate's max(updatedAt) moves.
    gaming.catalogueFingerprint.mockResolvedValue("1480:1756000999000");
    const body = await controller.gamingProfile(CUSTOMER, requestWith(stale), res);

    expect(status).toBeNull();
    expect(body).toBe(PAYLOAD);
    expect(headers.ETag).not.toBe(stale);
  });

  /** Two customers can hold different entitlements against the same
   * catalogue, so one customer's tag must never validate another's
   * response. */
  it("gives different customers different tags for the same catalogue", async () => {
    await controller.gamingProfile({ sub: "customer-1" } as any, requestWith(), res);
    const first = headers.ETag;
    await controller.gamingProfile({ sub: "customer-2" } as any, requestWith(), res);

    expect(headers.ETag).not.toBe(first);
  });

  /** Per-customer tags must not be cached by anything shared. */
  it("marks the response private and always revalidated", async () => {
    await controller.gamingProfile(CUSTOMER, requestWith(), res);

    expect(headers["Cache-Control"]).toContain("private");
    expect(headers["Cache-Control"]).toContain("no-cache");
  });
});
