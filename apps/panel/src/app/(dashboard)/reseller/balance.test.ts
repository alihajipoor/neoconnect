import { describe, expect, it } from "vitest";
import type { ResellerBalance } from "@/lib/types";
import { balanceLabel, canMintFrom } from "./balance";

const balance = (balance: number, isActive?: boolean): ResellerBalance => ({
  plan: { id: "p", name: "Pro", priceUsd: "5", durationDays: 30, isActive },
  balance,
});

describe("a reseller's balance for a plan", () => {
  it("can be minted from while the plan is offered and tokens are left", () => {
    expect(canMintFrom(balance(3, true))).toBe(true);
    // An older backend that does not say.
    expect(canMintFrom(balance(3))).toBe(true);
    expect(canMintFrom(balance(0, true))).toBe(false);
  });

  it("cannot be minted from once the plan is retired, and says why", () => {
    expect(canMintFrom(balance(3, false))).toBe(false);
    expect(balanceLabel(balance(3, false))).toBe("Pro — no longer offered");
    expect(balanceLabel(balance(3, true))).toBe("Pro — 3 left");
  });
});
