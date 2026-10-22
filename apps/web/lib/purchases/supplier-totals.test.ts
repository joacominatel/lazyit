import { describe, expect, test } from "bun:test";
import type { SupplierYearlyTotal } from "@lazyit/shared";
import { yearlyTotalGroups } from "./supplier-totals";

function total(partial: Partial<SupplierYearlyTotal> & Pick<SupplierYearlyTotal, "year">): SupplierYearlyTotal {
  return { currency: "ARS", amount: 100, unpricedLines: 0, purchaseCount: 1, ...partial };
}

describe("a supplier's yearly totals (#1500)", () => {
  test("an API older than #1500 sends no totals: nothing is shown, not an empty table", () => {
    expect(yearlyTotalGroups(undefined, "en")).toBeNull();
    expect(yearlyTotalGroups([], "en")).toEqual([]);
  });

  test("groups by year in the API's order, one entry per label, never summed across labels", () => {
    const groups = yearlyTotalGroups(
      [
        total({ year: 2026, currency: "ARS", amount: 141250000, purchaseCount: 3 }),
        total({ year: 2026, currency: "USD", amount: 115000, purchaseCount: 1 }),
        total({ year: 2025, currency: "ARS", amount: 50, purchaseCount: 2 }),
      ],
      "en",
    )!;
    expect(groups.map((g) => g.year)).toEqual([2026, 2025]);
    expect(groups[0]!.entries.map((e) => e.text)).toEqual(["ARS 1,412,500", "USD 1,150"]);
    expect(groups[0]!.entries.map((e) => e.purchaseCount)).toEqual([3, 1]);
    expect(groups[1]!.entries[0]!.text).toBe("ARS 0.50");
  });

  test("amounts follow the locale, like every purchase amount", () => {
    const groups = yearlyTotalGroups([total({ year: 2026, amount: 141250050 })], "es")!;
    expect(groups[0]!.entries[0]!.text).toBe("ARS 1.412.500,50");
  });

  test("no label, or a blank one, is the No currency group and prints the amount bare", () => {
    const groups = yearlyTotalGroups(
      [total({ year: 2026, currency: null, amount: 1000 }), total({ year: 2025, currency: "  ", amount: 1000 })],
      "en",
    )!;
    expect(groups[0]!.entries[0]).toMatchObject({ text: "10", noCurrency: true });
    expect(groups[1]!.entries[0]).toMatchObject({ text: "10", noCurrency: true });
  });

  test("a sum too large to hold reads null (the page says too large to display), unpriced lines are kept", () => {
    const groups = yearlyTotalGroups([total({ year: 2026, amount: null, unpricedLines: 2 })], "en")!;
    expect(groups[0]!.entries[0]).toMatchObject({ text: null, unpricedLines: 2, noCurrency: false });
  });
});
