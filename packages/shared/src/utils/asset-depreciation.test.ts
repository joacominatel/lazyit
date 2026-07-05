import { describe, expect, test } from "bun:test";
import { computeAssetBookValue } from "./asset-depreciation";

/**
 * Unit spec for the straight-line depreciation util (#954). Money is minor units (cents). Dates use
 * UTC midnights so the whole-month math is deterministic regardless of the runner's timezone.
 */

const utc = (y: number, m: number, d: number) =>
  new Date(Date.UTC(y, m - 1, d));

// A $1000 laptop, 20-month life, $200 salvage → depreciable base $800 (80000 cents), $40/mo.
const laptop = {
  purchaseCost: 100_000,
  usefulLifeMonths: 20,
  salvageValue: 20_000,
  purchaseDate: utc(2026, 1, 1),
};

describe("computeAssetBookValue", () => {
  test("null purchaseCost → null (unknown)", () => {
    expect(
      computeAssetBookValue({ ...laptop, purchaseCost: null }, utc(2026, 6, 1)),
    ).toBeNull();
  });

  test("no usefulLifeMonths → full cost (can't depreciate)", () => {
    expect(
      computeAssetBookValue(
        { ...laptop, usefulLifeMonths: null },
        utc(2030, 1, 1),
      ),
    ).toBe(100_000);
  });

  test("no purchaseDate → full cost (can't depreciate)", () => {
    expect(
      computeAssetBookValue({ ...laptop, purchaseDate: null }, utc(2030, 1, 1)),
    ).toBe(100_000);
  });

  test("usefulLifeMonths <= 0 is guarded → full cost", () => {
    expect(
      computeAssetBookValue(
        { ...laptop, usefulLifeMonths: 0 },
        utc(2030, 1, 1),
      ),
    ).toBe(100_000);
    expect(
      computeAssetBookValue(
        { ...laptop, usefulLifeMonths: -5 },
        utc(2030, 1, 1),
      ),
    ).toBe(100_000);
  });

  test("before purchaseDate → full cost (elapsed clamped to 0)", () => {
    expect(computeAssetBookValue(laptop, utc(2025, 6, 1))).toBe(100_000);
  });

  test("at purchaseDate → full cost", () => {
    expect(computeAssetBookValue(laptop, utc(2026, 1, 1))).toBe(100_000);
  });

  test("mid-life is linear: 5 of 20 months = 25% of $800 depreciated", () => {
    // 5 months → 100000 - 80000 * (5/20) = 100000 - 20000 = 80000
    expect(computeAssetBookValue(laptop, utc(2026, 6, 1))).toBe(80_000);
  });

  test("half-life: 10 of 20 months = $600", () => {
    expect(computeAssetBookValue(laptop, utc(2026, 11, 1))).toBe(60_000);
  });

  test("exactly end of life → floored at salvage", () => {
    expect(computeAssetBookValue(laptop, utc(2027, 9, 1))).toBe(20_000);
  });

  test("past end of life → stays at salvage (never below)", () => {
    expect(computeAssetBookValue(laptop, utc(2035, 1, 1))).toBe(20_000);
  });

  test("null salvageValue is treated as 0", () => {
    // 10 of 20 months, depreciable = full 100000 → 100000 - 100000*0.5 = 50000
    expect(
      computeAssetBookValue(
        { ...laptop, salvageValue: null },
        utc(2026, 11, 1),
      ),
    ).toBe(50_000);
  });

  test("accepts an ISO string purchaseDate", () => {
    expect(
      computeAssetBookValue(
        { ...laptop, purchaseDate: "2026-01-01T00:00:00.000Z" },
        utc(2026, 6, 1),
      ),
    ).toBe(80_000);
  });

  test("unparseable date string → full cost (can't depreciate)", () => {
    expect(
      computeAssetBookValue(
        { ...laptop, purchaseDate: "not-a-date" },
        utc(2030, 1, 1),
      ),
    ).toBe(100_000);
  });

  test("day-of-month not yet reached subtracts the partial month", () => {
    // purchase on the 15th; as-of the 10th five months later → only 4 whole months elapsed.
    const mid = { ...laptop, purchaseDate: utc(2026, 1, 15) };
    // 4/20 of 80000 = 16000 depreciated → 84000
    expect(computeAssetBookValue(mid, utc(2026, 6, 10))).toBe(84_000);
    // on/after the 15th → 5 whole months → 80000
    expect(computeAssetBookValue(mid, utc(2026, 6, 15))).toBe(80_000);
  });

  test("degenerate salvage > cost collapses to cost (never rises above)", () => {
    expect(
      computeAssetBookValue(
        {
          purchaseCost: 50_000,
          usefulLifeMonths: 10,
          salvageValue: 90_000,
          purchaseDate: utc(2026, 1, 1),
        },
        utc(2026, 6, 1),
      ),
    ).toBe(50_000);
  });
});
