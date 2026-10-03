import { describe, expect, test } from "bun:test";
import {
  addMonthsUtc,
  applyActionOf,
  costApplyActionOf,
  purchaseLineValues,
  warrantyEndFrom,
} from "./purchase-line-values";

const MODEL = "ckmodel000000000000000001";
const header = {
  orderDate: "2026-03-03T00:00:00.000Z",
  invoiceDate: "2026-03-10T00:00:00.000Z",
  currency: "ARS",
  company: "Acme S.A.",
};
const line = { unitPrice: 141250000, warrantyMonths: 36, assetModelId: MODEL };

describe("purchaseLineValues — the apply mapping (ADR-0099 §2)", () => {
  test("invoice date first; cost with the purchase's label; warranty from that date; company; model", () => {
    expect(purchaseLineValues(header, line)).toEqual({
      purchaseDate: "2026-03-10T00:00:00.000Z",
      purchaseDateSource: "INVOICE",
      purchaseCost: { amount: 141250000, currency: "ARS" },
      warrantyEnd: "2029-03-10T00:00:00.000Z",
      company: "Acme S.A.",
      modelId: MODEL,
    });
  });

  test("without an invoice date the order date is offered; without either, nothing — and no warranty", () => {
    const fromOrder = purchaseLineValues({ ...header, invoiceDate: null }, line);
    expect(fromOrder.purchaseDate).toBe("2026-03-03T00:00:00.000Z");
    expect(fromOrder.purchaseDateSource).toBe("ORDER");
    const none = purchaseLineValues({ ...header, invoiceDate: null, orderDate: null }, line);
    expect(none.purchaseDate).toBeNull();
    expect(none.purchaseDateSource).toBeNull();
    expect(none.warrantyEnd).toBeNull();
  });

  test("an unknown price offers no cost (never a 0), a 0 price offers a free unit", () => {
    expect(purchaseLineValues(header, { ...line, unitPrice: null }).purchaseCost).toBeNull();
    expect(purchaseLineValues(header, { ...line, unitPrice: 0 }).purchaseCost).toEqual({
      amount: 0,
      currency: "ARS",
    });
  });
});

describe("addMonthsUtc / warrantyEndFrom", () => {
  test("adds calendar months in UTC, clamping to the month's last day", () => {
    expect(addMonthsUtc("2026-01-31T00:00:00.000Z", 1)).toBe("2026-02-28T00:00:00.000Z");
    expect(addMonthsUtc("2028-01-31T00:00:00.000Z", 1)).toBe("2028-02-29T00:00:00.000Z");
    expect(addMonthsUtc("2026-11-15T10:30:00.000Z", 3)).toBe("2027-02-15T10:30:00.000Z");
    expect(addMonthsUtc("2026-05-01T00:00:00.000Z", 0)).toBe("2026-05-01T00:00:00.000Z");
  });

  test("is null when the date or the months are unknown", () => {
    expect(warrantyEndFrom(null, 12)).toBeNull();
    expect(warrantyEndFrom("2026-01-01T00:00:00.000Z", null)).toBeNull();
  });
});

describe("the diff actions", () => {
  test("plain values: FILL on empty, SAME on equal, REPLACE on different, UNAVAILABLE with nothing offered", () => {
    expect(applyActionOf(null, "Acme")).toBe("FILL");
    expect(applyActionOf("Acme", "Acme")).toBe("SAME");
    expect(applyActionOf("Other", "Acme")).toBe("REPLACE");
    expect(applyActionOf("Acme", null)).toBe("UNAVAILABLE");
    expect(applyActionOf(null, null)).toBe("UNAVAILABLE");
  });

  test("dates compare by instant", () => {
    expect(
      applyActionOf("2026-03-10T00:00:00Z", "2026-03-10T00:00:00.000Z", "date"),
    ).toBe("SAME");
    expect(
      applyActionOf("2026-03-11T00:00:00.000Z", "2026-03-10T00:00:00.000Z", "date"),
    ).toBe("REPLACE");
  });

  test("cost: the label is part of the value (trimmed, case-insensitive); empty amount is a FILL", () => {
    const offered = { amount: 1000, currency: "USD" };
    expect(costApplyActionOf({ amount: null, currency: "EUR" }, offered)).toBe("FILL");
    expect(costApplyActionOf({ amount: 1000, currency: " usd " }, offered)).toBe("SAME");
    expect(costApplyActionOf({ amount: 1000, currency: "ARS" }, offered)).toBe("REPLACE");
    expect(costApplyActionOf({ amount: 1000, currency: null }, offered)).toBe("REPLACE");
    expect(costApplyActionOf({ amount: 999, currency: "USD" }, offered)).toBe("REPLACE");
    expect(costApplyActionOf({ amount: 1000, currency: "USD" }, null)).toBe("UNAVAILABLE");
  });
});
