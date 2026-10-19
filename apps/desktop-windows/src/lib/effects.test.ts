import { describe, expect, it } from "vitest";
import { glassTier, lowerTier, motionReduced, p90, SLOW_FRAME_P90_MS, startingTier } from "./effects";

describe("the glass tier", () => {
  it("is flat whenever the OS asks for reduced transparency, whatever was chosen", () => {
    for (const choice of ["auto", "full", "lite", "flat"] as const) {
      expect(glassTier({ choice, reducedTransparency: true, hints: {} })).toEqual({ tier: "flat", osSet: true });
    }
  });

  it("is the customer's choice otherwise", () => {
    for (const choice of ["full", "lite", "flat"] as const) {
      expect(glassTier({ choice, reducedTransparency: false, hints: { renderer: "SwiftShader" } })).toEqual({
        tier: choice,
        osSet: false,
      });
    }
  });

  it("starts from the device on auto: flat on a software renderer, lite on little memory, full otherwise", () => {
    expect(startingTier({ renderer: "Google SwiftShader" })).toBe("flat");
    expect(startingTier({ renderer: "ANGLE (Microsoft Basic Render Driver Direct3D11)" })).toBe("flat");
    expect(startingTier({ renderer: "ANGLE (Intel(R) UHD Graphics 620 Direct3D11)", deviceMemory: 2 })).toBe("lite");
    expect(startingTier({ renderer: "ANGLE (NVIDIA GeForce RTX 3060)", deviceMemory: 8 })).toBe("full");
    expect(startingTier({})).toBe("full");
    // What a probe on this device found outranks every guess.
    expect(startingTier({ renderer: "SwiftShader", probed: "lite" })).toBe("lite");
  });

  it("drops one tier at a time after a slow probe", () => {
    expect(lowerTier("full")).toBe("lite");
    expect(lowerTier("lite")).toBe("flat");
    expect(lowerTier("flat")).toBe("flat");
    const slow = Array.from({ length: 60 }, (_, i) => (i < 50 ? 16 : 40));
    expect(p90(slow)).toBeGreaterThan(SLOW_FRAME_P90_MS);
    expect(p90(Array(60).fill(16.7))).toBeLessThan(SLOW_FRAME_P90_MS);
    expect(p90([])).toBe(0);
  });
});

describe("reduced motion", () => {
  it("is on, and set by the OS, whenever the OS asks", () => {
    expect(motionReduced(true, false)).toEqual({ reduce: true, osSet: true });
    expect(motionReduced(true, null)).toEqual({ reduce: true, osSet: true });
  });

  it("follows the app's switch otherwise, off by default", () => {
    expect(motionReduced(false, true)).toEqual({ reduce: true, osSet: false });
    expect(motionReduced(false, false)).toEqual({ reduce: false, osSet: false });
    expect(motionReduced(false, null)).toEqual({ reduce: false, osSet: false });
  });
});
