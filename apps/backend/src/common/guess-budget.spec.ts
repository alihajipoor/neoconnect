import { GuessBudget, guessKey } from "./guess-budget";

describe("GuessBudget", () => {
  const HOUR = 60 * 60 * 1000;

  it("allows max guesses in a window and refuses the rest", () => {
    const budget = new GuessBudget(3, HOUR);
    const results = Array.from({ length: 5 }, () => budget.take("a", 0));
    expect(results).toEqual([true, true, true, false, false]);
    expect(budget.spent("a", 0)).toBe(true);
  });

  it("starts over when the window has passed, and not before", () => {
    const budget = new GuessBudget(1, HOUR);
    expect(budget.take("a", 0)).toBe(true);
    expect(budget.take("a", HOUR - 1)).toBe(false);
    expect(budget.take("a", HOUR)).toBe(true);
  });

  it("keeps accounts apart", () => {
    const budget = new GuessBudget(1, HOUR);
    expect(budget.take("a", 0)).toBe(true);
    expect(budget.take("b", 0)).toBe(true);
  });

  it("gives back a refunded guess and forgets an account left with none", () => {
    const budget = new GuessBudget(1, HOUR);
    budget.take("a", 0);
    budget.refund("a");
    expect(budget.spent("a", 0)).toBe(false);
    expect(budget.take("a", 0)).toBe(true);
  });

  it("starts over after a success", () => {
    const budget = new GuessBudget(1, HOUR);
    budget.take("a", 0);
    budget.clear("a");
    expect(budget.take("a", 1)).toBe(true);
  });

  it("keys case variants of one address together", () => {
    expect(guessKey(" Customer@Example.COM ")).toBe(guessKey("customer@example.com"));
  });
});
