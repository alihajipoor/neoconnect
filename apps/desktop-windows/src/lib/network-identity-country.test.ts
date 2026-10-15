import { beforeEach, describe, expect, it, vi } from "vitest";

/** The server's country stamp per network, which is the relay of last
 * resort's evidence of Iran (docs/relay-last-resort.md, R1.3). */

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const { latestStampedCountry, networkKeyFromAsn, rememberNetwork, resetNetworkForTests, stampedCountry } = await import(
  "./network-identity"
);

beforeEach(() => {
  store.clear();
  resetNetworkForTests();
});

describe("the country stamp", () => {
  it("is kept per network, from a baseline that carried one", () => {
    rememberNetwork({ ip: "192.0.2.1", asn: 58224, country: "IR" }, 1_000);
    expect(networkKeyFromAsn(1_000)).toBe("asn:58224");
    expect(stampedCountry("asn:58224")).toBe("IR");
    rememberNetwork({ ip: "192.0.2.2", asn: 3320, country: "DE" }, 2_000);
    expect(stampedCountry("asn:3320")).toBe("DE");
    expect(stampedCountry("asn:58224")).toBe("IR");
  });

  it("is left as it was by a baseline with no country -- a node mirror answered it", () => {
    rememberNetwork({ ip: "192.0.2.1", asn: 58224, country: "IR" }, 1_000);
    rememberNetwork({ ip: "192.0.2.1", asn: 58224 }, 2_000);
    expect(stampedCountry("asn:58224")).toBe("IR");
  });

  it("is nothing for a network never stamped, an unknown one, or a malformed country", () => {
    expect(stampedCountry("asn:1")).toBeNull();
    expect(stampedCountry(null)).toBeNull();
    rememberNetwork({ ip: "192.0.2.1", asn: 44244, country: "Iran" }, 1_000);
    expect(stampedCountry("asn:44244")).toBeNull();
    rememberNetwork({ ip: "192.0.2.1", country: "IR" }, 1_000);
    expect(stampedCountry("unknown")).toBeNull();
  });

  it("names the latest stamp of any network, for a device that cannot say which network it is on", () => {
    // Every route blocked means no fresh baseline, and a day later no
    // network key: the last place the server saw the device is still the
    // best word on where it is.
    expect(latestStampedCountry()).toBeNull();
    rememberNetwork({ ip: "192.0.2.1", asn: 58224, country: "IR" }, 1_000);
    rememberNetwork({ ip: "192.0.2.2", asn: 3320, country: "DE" }, 2_000);
    expect(latestStampedCountry()).toBe("DE");
    expect(networkKeyFromAsn(2_000 + 24 * 3_600_000)).toBeNull();
    expect(latestStampedCountry()).toBe("DE");
    rememberNetwork({ ip: "192.0.2.1", asn: 58224, country: "IR" }, 3_000);
    expect(latestStampedCountry()).toBe("IR");
  });
});
