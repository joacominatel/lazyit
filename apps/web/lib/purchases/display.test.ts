import { describe, expect, test } from "bun:test";
import {
  canCancelPurchase,
  purchaseDisplayStatus,
  purchaseTitle,
  receiptProgress,
  totalLines,
} from "./display";

const base = { reference: null, supplier: null, orderDate: null, createdAt: "2026-10-01T12:00:00.000Z" };

describe("purchaseTitle (ADR-0099 §6)", () => {
  test("the finance reference names the purchase", () => {
    expect(purchaseTitle({ ...base, reference: " OC 0001-00004512 ", supplier: { name: "Compumundo" } })).toEqual({
      kind: "reference",
      reference: "OC 0001-00004512",
    });
  });

  test("without a reference: supplier and order date", () => {
    expect(
      purchaseTitle({ ...base, supplier: { name: "Mercado Libre" }, orderDate: "2026-03-22T00:00:00.000Z" }),
    ).toEqual({ kind: "supplier", supplier: "Mercado Libre", date: "2026-03-22T00:00:00.000Z" });
  });

  test("falls back to the day it was recorded when there is no order date", () => {
    expect(purchaseTitle({ ...base, supplier: { name: "Dell" } })).toEqual({
      kind: "supplier",
      supplier: "Dell",
      date: base.createdAt,
    });
  });

  test("a purchase identified only by its lines is untitled with a date", () => {
    expect(purchaseTitle({ ...base, reference: "   " })).toEqual({ kind: "untitled", date: base.createdAt });
  });
});

describe("purchaseDisplayStatus (ADR-0099 §3)", () => {
  test("stored statuses show as stored", () => {
    expect(purchaseDisplayStatus("DRAFT", { state: "PARTIAL" })).toBe("draft");
    expect(purchaseDisplayStatus("CANCELLED", null)).toBe("cancelled");
  });

  test("an ordered purchase is refined by what was received", () => {
    expect(purchaseDisplayStatus("ORDERED", null)).toBe("ordered");
    expect(purchaseDisplayStatus("ORDERED", { state: "NONE" })).toBe("ordered");
    expect(purchaseDisplayStatus("ORDERED", { state: "PARTIAL" })).toBe("partial");
    expect(purchaseDisplayStatus("ORDERED", { state: "RECEIVED" })).toBe("received");
    expect(purchaseDisplayStatus("ORDERED", { state: "OVER" })).toBe("over");
  });

  test("a status a newer build wrote reads as unknown, never throws", () => {
    expect(purchaseDisplayStatus("ON_HOLD", null)).toBe("unknown");
  });
});

describe("totalLines (ADR-0099 §5)", () => {
  test("one line per label, never summed across labels", () => {
    const lines = totalLines(
      [
        { currency: "ARS", amount: 795500000, unpricedLines: 0 },
        { currency: "USD", amount: 460000, unpricedLines: 1 },
      ],
      "es",
    );
    expect(lines.map((l) => l.text)).toEqual(["ARS 7.955.000", "USD 4.600"]);
    expect(lines[1]!.unpricedLines).toBe(1);
  });

  test("decimals only when entered, in the viewer's locale", () => {
    expect(totalLines([{ currency: "u$s", amount: 123456, unpricedLines: 0 }], "en")[0]!.text).toBe(
      "u$s 1,234.56",
    );
  });

  test("no currency is its own visible state", () => {
    const [line] = totalLines([{ currency: null, amount: 150000, unpricedLines: 0 }], "es");
    expect(line).toEqual({ key: "", text: "1.500", noCurrency: true, unpricedLines: 0 });
  });

  test("a sum too large to show exactly prints no number", () => {
    expect(totalLines([{ currency: "ARS", amount: null, unpricedLines: 0 }], "es")[0]!.text).toBeNull();
  });
});

describe("receiptProgress (ADR-0099 §4)", () => {
  test("x of y with pending and cancelled", () => {
    expect(receiptProgress({ state: "PARTIAL", ordered: 14, received: 11, cancelled: 2, pending: 1 })).toEqual({
      received: 11,
      ordered: 14,
      pending: 1,
      cancelled: 2,
      over: false,
      ratio: 11 / 12,
    });
  });

  test("over-received is flagged, the bar stays full", () => {
    const progress = receiptProgress({ state: "OVER", ordered: 4, received: 5, cancelled: 0, pending: 0 });
    expect(progress.over).toBe(true);
    expect(progress.ratio).toBe(1);
  });

  test("a fully cancelled line counts as done", () => {
    const progress = receiptProgress({ state: "RECEIVED", ordered: 2, received: 0, cancelled: 2, pending: 0 });
    expect(progress.over).toBe(false);
    expect(progress.ratio).toBe(1);
  });
});

describe("canCancelPurchase (ADR-0099 §3)", () => {
  test("only while nothing is received", () => {
    expect(canCancelPurchase("ORDERED", { received: 0 })).toBe(true);
    expect(canCancelPurchase("DRAFT", null)).toBe(true);
    expect(canCancelPurchase("ORDERED", { received: 1 })).toBe(false);
    expect(canCancelPurchase("CANCELLED", null)).toBe(false);
  });
});
