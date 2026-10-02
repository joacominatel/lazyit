import { describe, expect, test } from "bun:test";
import { buildStockReceivePayload, stockReceivePrefill, stockReceiveQuantity } from "./receive-stock";

describe("receiving a consumable line into stock (#1476)", () => {
  test("the quantity starts at every pending unit", () => {
    expect(stockReceivePrefill({ pendingQuantity: 12 })).toEqual({ quantity: "12", note: "" });
  });

  test("nothing pending starts blank — the count that arrived is typed, never guessed", () => {
    expect(stockReceivePrefill({ pendingQuantity: 0 })).toEqual({ quantity: "", note: "" });
  });

  test("the body is the quantity, plus the note only when one was typed", () => {
    expect(buildStockReceivePayload({ quantity: " 10 ", note: "  " })).toEqual({ ok: true, payload: { quantity: 10 } });
    expect(buildStockReceivePayload({ quantity: "10", note: " box 2 of 2 " })).toEqual({
      ok: true,
      payload: { quantity: 10, note: "box 2 of 2" },
    });
  });

  test("more than pending is still a valid receipt — over-receipt is a warning, not a refusal", () => {
    expect(buildStockReceivePayload({ quantity: "50", note: "" })).toEqual({ ok: true, payload: { quantity: 50 } });
  });

  test("blank, zero, decimals, signs and counts past int4 are refused on the field", () => {
    for (const text of ["", "0", "1.5", "-2", "1e3", "2147483648"]) {
      expect(buildStockReceivePayload({ quantity: text, note: "" })).toEqual({ ok: false });
    }
    expect(stockReceiveQuantity("3")).toBe(3);
    expect(stockReceiveQuantity("abc")).toBeNull();
  });

  test("a note longer than the ledger keeps is refused rather than cut", () => {
    expect(buildStockReceivePayload({ quantity: "1", note: "x".repeat(2001) })).toEqual({ ok: false });
  });
});
