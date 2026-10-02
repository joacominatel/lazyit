import { describe, expect, test } from "bun:test";
import { MONEY_MAX } from "../schemas/primitives";
import { currencyGroupKey, groupMoneyTotals } from "./money-totals";

describe("currencyGroupKey", () => {
  test("trims and lower-cases; blank and missing are the same 'No currency' key", () => {
    expect(currencyGroupKey(" USD ")).toBe("usd");
    expect(currencyGroupKey("u$s")).toBe("u$s");
    expect(currencyGroupKey("   ")).toBe("");
    expect(currencyGroupKey(null)).toBe("");
    expect(currencyGroupKey(undefined)).toBe("");
  });
});

describe("groupMoneyTotals (ADR-0099 §5 — never summed across labels)", () => {
  test("groups trimmed and case-insensitively, keeps the first spelling, never mixes labels", () => {
    const totals = groupMoneyTotals([
      { currency: "USD", amount: 1000 },
      { currency: "usd ", amount: 500 },
      { currency: "ARS", amount: 2_000_000 },
      { currency: null, amount: 7 },
      { currency: "  ", amount: 3 },
      { currency: "u$s", amount: 1 },
    ]);
    expect(totals).toEqual([
      { currency: "USD", amount: 1500, unpricedLines: 0 },
      { currency: "ARS", amount: 2_000_000, unpricedLines: 0 },
      { currency: null, amount: 10, unpricedLines: 0 },
      // "u$s" is its own label: lazyit never interprets one as another.
      { currency: "u$s", amount: 1, unpricedLines: 0 },
    ]);
  });

  test("an unknown amount adds nothing and is counted as unpriced", () => {
    expect(
      groupMoneyTotals([
        { currency: "EUR", amount: null },
        { currency: "EUR", amount: 0 },
        { currency: "EUR", amount: undefined },
      ]),
    ).toEqual([{ currency: "EUR", amount: 0, unpricedLines: 2 }]);
  });

  test("sums exactly in bigint and reports null instead of an inexact amount past MONEY_MAX", () => {
    expect(
      groupMoneyTotals([
        { currency: "ARS", amount: MONEY_MAX - 1 },
        { currency: "ARS", amount: 1 },
      ]),
    ).toEqual([{ currency: "ARS", amount: MONEY_MAX, unpricedLines: 0 }]);
    expect(
      groupMoneyTotals([
        { currency: "ARS", amount: BigInt(MONEY_MAX) },
        { currency: "ARS", amount: 1 },
      ]),
    ).toEqual([{ currency: "ARS", amount: null, unpricedLines: 0 }]);
  });

  test("no entries → no groups", () => {
    expect(groupMoneyTotals([])).toEqual([]);
  });
});
