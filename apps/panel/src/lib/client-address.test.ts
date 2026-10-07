import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: vi.fn() }));

import { CLOUDFLARE_V4, CLOUDFLARE_V6, clientAddressFrom } from "./client-address";

const h = (values: Record<string, string>) => new Headers(values);

describe("clientAddressFrom", () => {
  it("takes the address nginx saw when X-Real-IP and the last X-Forwarded-For entry agree", () => {
    // What installer/assets/nginx-panel.conf.template produces.
    expect(clientAddressFrom(h({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
    // The caller's own X-Forwarded-For is kept by nginx, to the left.
    expect(
      clientAddressFrom(h({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "10.9.9.9, 1.1.1.1, 203.0.113.7" })),
    ).toBe("203.0.113.7");
    expect(clientAddressFrom(h({ "x-real-ip": "2001:db8::5", "x-forwarded-for": "2001:db8::5" }))).toBe("2001:db8::5");
  });

  it("believes neither header when they disagree", () => {
    // A forged X-Real-IP that nginx did not replace: the appended entry is
    // the truth, and the disagreement says the setup is not the template's.
    expect(clientAddressFrom(h({ "x-real-ip": "198.51.100.1", "x-forwarded-for": "203.0.113.7" }))).toBeUndefined();
    // A forged rightmost X-Forwarded-For that nginx did not append to.
    expect(clientAddressFrom(h({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1" }))).toBeUndefined();
  });

  it("needs both headers", () => {
    // `next dev` with no nginx: Next fills X-Forwarded-For with the socket
    // peer and nothing sets X-Real-IP.
    expect(clientAddressFrom(h({ "x-forwarded-for": "::1" }))).toBeUndefined();
    expect(clientAddressFrom(h({ "x-real-ip": "203.0.113.7" }))).toBeUndefined();
    expect(clientAddressFrom(h({}))).toBeUndefined();
  });

  it("refuses anything that is not an address", () => {
    expect(clientAddressFrom(h({ "x-real-ip": "evil", "x-forwarded-for": "evil" }))).toBeUndefined();
    expect(clientAddressFrom(h({ "x-real-ip": "1.2.3.4:5", "x-forwarded-for": "1.2.3.4:5" }))).toBeUndefined();
  });

  it("reads Cloudflare's header only when the peer is a Cloudflare edge", () => {
    const viaCloudflare = h({
      "x-real-ip": "162.158.41.5",
      "x-forwarded-for": "50.47.175.127, 162.158.41.5",
      "cf-connecting-ip": "50.47.175.127",
    });
    expect(clientAddressFrom(viaCloudflare)).toBe("50.47.175.127");

    const v6Edge = h({ "x-real-ip": "2606:4700::1", "x-forwarded-for": "2606:4700::1", "cf-connecting-ip": "2001:db8::9" });
    expect(clientAddressFrom(v6Edge)).toBe("2001:db8::9");

    // Straight to the origin with the header written by the caller.
    const direct = h({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.7", "cf-connecting-ip": "8.8.8.8" });
    expect(clientAddressFrom(direct)).toBe("203.0.113.7");

    // An edge with no usable header still counts as the edge, as the
    // backend's own routes do.
    const edgeNoHeader = h({ "x-real-ip": "162.158.41.5", "x-forwarded-for": "162.158.41.5", "cf-connecting-ip": "x" });
    expect(clientAddressFrom(edgeNoHeader)).toBe("162.158.41.5");
  });

  it("uses the same Cloudflare ranges as the backend", () => {
    const backend = readFileSync(new URL("../../../backend/src/common/cloudflare.ts", import.meta.url), "utf8");
    const cidrs = [...backend.matchAll(/"([0-9a-f:.]+\/\d+)"/gi)].map((m) => m[1]);
    expect([...CLOUDFLARE_V4, ...CLOUDFLARE_V6].sort()).toEqual([...cidrs].sort());
  });
});
