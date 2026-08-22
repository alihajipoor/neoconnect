import { afterEach, describe, expect, it, vi } from "vitest";
import { isServiceTimeout, SERVICE_TIMEOUT_MARKER, withTimeout } from "./service-call";

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("gives up on a call that never answers", async () => {
    vi.useFakeTimers();
    // The pipe read has no deadline of its own, so this is exactly the
    // shape of the call that wedged the dashboard: accepted, and then
    // silence forever.
    const bounded = withTimeout(new Promise<string>(() => {}), "vpn_disconnect", 6_000);
    const settled = expect(bounded).rejects.toThrow(SERVICE_TIMEOUT_MARKER);
    await vi.advanceTimersByTimeAsync(6_000);
    await settled;
  });

  it("passes a real answer straight through", async () => {
    await expect(withTimeout(Promise.resolve("ok"), "vpn_status", 6_000)).resolves.toBe("ok");
  });

  it("keeps the service's own failure rather than replacing it", async () => {
    // A service that refused says why, and that text is the only record
    // of the reason -- flattening it into a timeout would lose it.
    await expect(
      withTimeout(Promise.reject(new Error("engine is missing from the installation")), "vpn_connect", 6_000),
    ).rejects.toThrow("engine is missing from the installation");
  });

  it("stops the clock once the call has settled", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve("ok"), "vpn_status", 6_000)).resolves.toBe("ok");
    // A timer left running would reject an already-settled promise,
    // which is an unhandled rejection rather than a harmless leak.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("isServiceTimeout", () => {
  it("tells a silent service apart from one that answered with a failure", () => {
    // The distinction picks the sentence the customer reads: a teardown
    // that may still be finishing, or a server that refused. Only one
    // of them is a claim about the node.
    expect(isServiceTimeout(new Error(`vpn_disconnect ${SERVICE_TIMEOUT_MARKER} (6000ms)`))).toBe(true);
    expect(isServiceTimeout("the tunnel handshake timed out")).toBe(false);
    expect(isServiceTimeout(null)).toBe(false);
  });
});
