import { isCloudflareAddress } from "./cloudflare";

describe("isCloudflareAddress", () => {
  it("knows the edge measured in production, and both ends of a range", () => {
    expect(isCloudflareAddress("162.158.41.5")).toBe(true);
    expect(isCloudflareAddress("104.16.0.0")).toBe(true);
    expect(isCloudflareAddress("104.23.255.255")).toBe(true);
    expect(isCloudflareAddress("2606:4700:10::6816:1")).toBe(true);
  });

  it("reads an IPv4 address in its IPv6-mapped form, as Node reports it", () => {
    expect(isCloudflareAddress("::ffff:172.64.1.1")).toBe(true);
  });

  it("is not anyone else", () => {
    expect(isCloudflareAddress("104.28.1.1")).toBe(false); // WARP egress: Cloudflare's AS, not a proxy
    expect(isCloudflareAddress("198.51.100.7")).toBe(false);
    expect(isCloudflareAddress("127.0.0.1")).toBe(false);
    expect(isCloudflareAddress("2001:db8::1")).toBe(false);
    expect(isCloudflareAddress("not an address")).toBe(false);
    expect(isCloudflareAddress(undefined)).toBe(false);
    expect(isCloudflareAddress("")).toBe(false);
  });
});
