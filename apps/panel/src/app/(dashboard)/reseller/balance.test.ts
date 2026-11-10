import { describe, expect, it } from "vitest";
import type { ResellerBalance } from "@/lib/types";
import { balanceLabel, canMintFrom, planToActivate } from "./balance";

const balance = (balance: number, isActive?: boolean, id = "p"): ResellerBalance => ({
  plan: { id, name: "Pro", priceUsd: "5", durationDays: 30, isActive },
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

describe("the plan an activation will use", () => {
  const balances = [balance(0, true, "empty"), balance(2, true, "a"), balance(1, true, "b"), balance(4, false, "retired")];

  it("is the one picked, while it has tokens and is still offered", () => {
    expect(planToActivate(balances, "b")).toBe("b");
  });

  it("falls to the first that can be spent from once the picked one cannot", () => {
    // Nothing picked yet, the last token just went, or the plan was retired.
    expect(planToActivate(balances, "")).toBe("a");
    expect(planToActivate(balances, "empty")).toBe("a");
    expect(planToActivate(balances, "retired")).toBe("a");
  });

  it("is nothing when no plan can be spent from", () => {
    expect(planToActivate([balance(0, true, "empty"), balance(4, false, "retired")], "empty")).toBe("");
  });
});
