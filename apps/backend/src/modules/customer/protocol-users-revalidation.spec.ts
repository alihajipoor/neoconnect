import { HttpStatus } from "@nestjs/common";
import type { Request, Response } from "express";
import { CustomerController } from "./customer.controller";

/** `GET /customer/protocol-users` answers an unchanged list with a 304.
 *
 * The apps' background config refresh asks for it on every foreground and
 * before a connect, and it is ~100 KB of JSON for a normal account that has
 * almost never changed. On restricted lines it is the body that does not
 * arrive: 87 of 189 failed refreshes in 48 h on two networks had their 200
 * in hand and ran out of time reading it. An app holding the previous answer
 * offers its tag and an unchanged list costs a 304 with no body.
 *
 * These pin what makes that safe: the tag stands for the exact body this
 * caller gets, so it moves when the body does; one device's tag never
 * validates another's answer; and a caller that sends no validator -- every
 * app released before this -- gets the 200 and the body it always got. */
describe("GET /customer/protocol-users revalidation", () => {
  const CUSTOMER = { sub: "customer-1", sid: "session-a" } as any;
  // RFC 5737 address; node addresses are never committed.
  const LIST = [
    {
      id: "pu-1",
      routeId: "route-1",
      protocol: "XRAY_VLESS_REALITY",
      connection: { host: "203.0.113.10", port: 443, publicParams: { serverName: "www.example.com" } },
    },
  ];

  let protocolUsers: { listForDevice: jest.Mock };
  let controller: CustomerController;
  let headers: Record<string, string>;
  let status: number | null;
  let res: Response;

  function requestWith(ifNoneMatch?: string): Request {
    return { headers: ifNoneMatch ? { "if-none-match": ifNoneMatch } : {} } as unknown as Request;
  }

  beforeEach(() => {
    protocolUsers = { listForDevice: jest.fn().mockResolvedValue(LIST) };
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

    // Only the protocol-users service is exercised by this handler; it is
    // the third dependency, and the rest are never touched on this path.
    const deps = [undefined, undefined, protocolUsers, ...new Array(12).fill(undefined)] as unknown as ConstructorParameters<
      typeof CustomerController
    >;
    controller = new CustomerController(...deps);
  });

  it("serves today's answer, with a validator, to a caller that sends none", async () => {
    const body = await controller.protocolUsers(CUSTOMER, requestWith(), res);

    expect(body).toBe(LIST);
    expect(status).toBeNull();
    expect(headers.ETag).toMatch(/^W\/"pu-/);
    expect(protocolUsers.listForDevice).toHaveBeenCalledWith("customer-1", "session-a");
  });

  it("answers 304 with no body, and the tag again, when the list is unchanged", async () => {
    await controller.protocolUsers(CUSTOMER, requestWith(), res);
    const tag = headers.ETag;
    headers = {};

    const body = await controller.protocolUsers(CUSTOMER, requestWith(tag), res);

    expect(status).toBe(HttpStatus.NOT_MODIFIED);
    expect(body).toBeUndefined();
    expect(headers.ETag).toBe(tag);
  });

  it("serves the new list and its tag once anything in it changes", async () => {
    await controller.protocolUsers(CUSTOMER, requestWith(), res);
    const stale = headers.ETag;

    // A REALITY decoy moved: the field the config refresh exists for.
    const moved = [{ ...LIST[0], connection: { ...LIST[0].connection, publicParams: { serverName: "www.example.org" } } }];
    protocolUsers.listForDevice.mockResolvedValue(moved);
    const body = await controller.protocolUsers(CUSTOMER, requestWith(stale), res);

    expect(status).toBeNull();
    expect(body).toBe(moved);
    expect(headers.ETag).toMatch(/^W\/"pu-/);
    expect(headers.ETag).not.toBe(stale);
  });

  /** Each device has credentials of its own. Two sessions of one customer
   * get different tags even for an identical body, so a tag can only ever
   * validate the answer of the device it was given to. */
  it("gives different device sessions different tags", async () => {
    await controller.protocolUsers({ sub: "customer-1", sid: "session-a" } as any, requestWith(), res);
    const first = headers.ETag;
    await controller.protocolUsers({ sub: "customer-1", sid: "session-b" } as any, requestWith(first), res);

    expect(headers.ETag).not.toBe(first);
    expect(status).toBeNull();
  });

  it("gives different customers different tags for the same body", async () => {
    await controller.protocolUsers({ sub: "customer-1" } as any, requestWith(), res);
    const first = headers.ETag;
    await controller.protocolUsers({ sub: "customer-2" } as any, requestWith(), res);

    expect(headers.ETag).not.toBe(first);
  });

  /** Per-device credentials must not be cached by anything shared. */
  it("marks the response private and always revalidated", async () => {
    await controller.protocolUsers(CUSTOMER, requestWith(), res);

    expect(headers["Cache-Control"]).toContain("private");
    expect(headers["Cache-Control"]).toContain("no-cache");
  });

  /** A signed-out device is refused before any tag is minted. */
  it("lets a refusal through unchanged", async () => {
    protocolUsers.listForDevice.mockRejectedValue(new Error("This device has been signed out"));

    await expect(controller.protocolUsers(CUSTOMER, requestWith("W/\"pu-x\""), res)).rejects.toThrow("signed out");
    expect(headers.ETag).toBeUndefined();
  });
});
