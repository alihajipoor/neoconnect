import { describe, expect, it, vi, afterEach } from "vitest";
import { isAndroid, isIOS, protocolSupported } from "./platform";

/** Pretends to be a given client. `navigator` is read at call time, not
 * import time, so stubbing per test is enough. */
function on(userAgent: string, maxTouchPoints = 0) {
  vi.stubGlobal("navigator", { userAgent, maxTouchPoints });
}

describe("platform detection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("recognises Android", () => {
    on("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36");
    expect(isAndroid()).toBe(true);
    expect(isIOS()).toBe(false);
  });

  it("recognises iPhone", () => {
    on("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)");
    expect(isIOS()).toBe(true);
    expect(isAndroid()).toBe(false);
  });

  it("recognises iPadOS, which claims to be a Mac", () => {
    on("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5);
    expect(isIOS()).toBe(true);
  });

  it("does not mistake a real Mac for an iPad", () => {
    on("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0);
    expect(isIOS()).toBe(false);
  });
});

describe("protocol support", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers everything on Android", () => {
    on("Mozilla/5.0 (Linux; Android 14)");
    for (const p of ["XRAY_VLESS_REALITY", "WIREGUARD", "IKEV2", "SHADOWSOCKS"]) {
      expect(protocolSupported(p), p).toBe(true);
    }
  });

  it("offers only what iOS can carry", () => {
    on("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)");
    expect(protocolSupported("XRAY_VLESS_REALITY")).toBe(true);
    expect(protocolSupported("XRAY_TROJAN")).toBe(true);
    expect(protocolSupported("SHADOWSOCKS")).toBe(true);
    // Dialled by the system's own client, so it needs no provider of ours.
    expect(protocolSupported("IKEV2")).toBe(true);
    // Shares the packet-tunnel extension with Xray.
    expect(protocolSupported("WIREGUARD")).toBe(true);
    // No engine for it on either mobile platform.
    expect(protocolSupported("OPENVPN")).toBe(false);
  });

  it("still offers everything on Android, IKEv2 included", () => {
    on("Mozilla/5.0 (Linux; Android 14)");
    expect(protocolSupported("IKEV2")).toBe(true);
    expect(protocolSupported("WIREGUARD")).toBe(true);
  });
});
