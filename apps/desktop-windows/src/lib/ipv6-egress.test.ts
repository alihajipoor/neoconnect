import { afterEach, describe, expect, it, vi } from "vitest";

/** The one call `checkIpv6` makes, stood in for so the three-way verdict
 * can be exercised without a network. */
const probe = vi.fn<() => Promise<boolean>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string) => {
    if (command === "probe_ipv6_egress") return probe();
    throw new Error(`unexpected command ${command}`);
  },
}));

// egress.ts imports the HTTP plugin at module scope for the IPv4 half,
// which is untouched here and has no business being loaded in a test
// process.
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: () => Promise.reject(new Error("not used")) }));

const { checkIpv6 } = await import("./egress");

afterEach(() => {
  probe.mockReset();
});

describe("checkIpv6", () => {
  it("calls a machine with no IPv6 what it is, rather than protected", async () => {
    // The common case by a wide margin, and the one that decides whether
    // this check is usable at all. A probe that fails on a machine that
    // never had IPv6 is not evidence of anything, and reporting it as
    // "blocked" would put a line on screen about a gap that does not
    // exist for this customer.
    probe.mockResolvedValue(false);
    await expect(checkIpv6(false)).resolves.toBe("absent");
  });

  it("reports a block only where there was something to block", async () => {
    probe.mockResolvedValue(false);
    await expect(checkIpv6(true)).resolves.toBe("blocked");
  });

  it("reports IPv6 still reaching the internet as escaping", async () => {
    // The measured leak: IPv4 tunnelled through the node, IPv6 walking
    // out of the NIC. Every node is IPv4-only, so a reachable public
    // IPv6 address while connected cannot have gone through the tunnel.
    probe.mockResolvedValue(true);
    await expect(checkIpv6(true)).resolves.toBe("escaping");
  });

  it("still calls it escaping when no baseline was taken", async () => {
    // Adopting a tunnel that was already up when the app opened. There
    // is no "before" to compare against, but a probe that *succeeds*
    // needs none: the packets got out, and there was no IPv6 tunnel for
    // them to get out through.
    probe.mockResolvedValue(true);
    await expect(checkIpv6(null)).resolves.toBe("escaping");
  });

  it("stays quiet when no baseline was taken and nothing answers", async () => {
    // The other half of the same case, and the one where guessing would
    // hurt: silence proves nothing here, so it must not be dressed up as
    // a block we never observed.
    probe.mockResolvedValue(false);
    await expect(checkIpv6(null)).resolves.toBe("absent");
  });

  it("treats a command that could not be reached as no evidence", async () => {
    // A failed `invoke` says the app could not ask, which is not the
    // same as an answer -- and must never become an accusation on
    // screen.
    probe.mockRejectedValue(new Error("service unavailable"));
    await expect(checkIpv6(true)).resolves.toBe("blocked");
    await expect(checkIpv6(false)).resolves.toBe("absent");
  });
});
