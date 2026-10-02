import { describe, expect, test } from "bun:test";
import { purchaseTitle } from "./display";
import { costDiffersFromPurchase, provenanceTitleSource, purchasePanelMode } from "./provenance";

describe("the Purchase panel follows purchaseOrder:read (ADR-0099 D-A)", () => {
  test("without the permission it is hidden — linked or not, writer or not — so nothing is fetched", () => {
    for (const linked of [true, false]) {
      for (const canLink of [true, false]) {
        expect(purchasePanelMode({ canReadPurchases: false, canLink, linked, archived: false })).toBe("hidden");
      }
    }
  });

  test("a linked asset shows its provenance to any reader", () => {
    expect(purchasePanelMode({ canReadPurchases: true, canLink: false, linked: true, archived: false })).toBe(
      "provenance",
    );
    expect(purchasePanelMode({ canReadPurchases: true, canLink: false, linked: true, archived: true })).toBe(
      "provenance",
    );
  });

  test("an unlinked asset offers linking only to someone who can link, and only while live", () => {
    expect(purchasePanelMode({ canReadPurchases: true, canLink: true, linked: false, archived: false })).toBe("link");
    expect(purchasePanelMode({ canReadPurchases: true, canLink: false, linked: false, archived: false })).toBe(
      "hidden",
    );
    expect(purchasePanelMode({ canReadPurchases: true, canLink: true, linked: false, archived: true })).toBe(
      "hidden",
    );
  });
});

describe("differs from purchase — cost only", () => {
  test("a different amount, or the same amount in another currency label, differs", () => {
    expect(costDiffersFromPurchase({ purchaseCost: 115000, purchaseCurrency: "USD" }, { unitPrice: 141250000 }, "ARS")).toBe(
      true,
    );
    expect(costDiffersFromPurchase({ purchaseCost: 1000, purchaseCurrency: "USD" }, { unitPrice: 1000 }, "ARS")).toBe(true);
  });

  test("the same amount and label (ignoring case and spaces) does not", () => {
    expect(costDiffersFromPurchase({ purchaseCost: 1000, purchaseCurrency: "usd " }, { unitPrice: 1000 }, "USD")).toBe(
      false,
    );
  });

  test("nothing to compare is not a difference: no cost on the asset, or no price on the line", () => {
    expect(costDiffersFromPurchase({ purchaseCost: null, purchaseCurrency: null }, { unitPrice: 1000 }, "ARS")).toBe(false);
    expect(costDiffersFromPurchase({ purchaseCost: 1000 }, { unitPrice: null }, "ARS")).toBe(false);
  });
});

describe("the panel titles the purchase as everywhere else (#1476)", () => {
  const line = { createdAt: "2026-09-20T15:00:00.000Z" };
  const purchase = { reference: null, supplier: null, orderDate: null, createdAt: "2026-08-01T12:00:00.000Z" };

  test("without reference, supplier or order date, the date is when the purchase was recorded — not the line", () => {
    expect(purchaseTitle(provenanceTitleSource(purchase, line))).toEqual({
      kind: "untitled",
      date: "2026-08-01T12:00:00.000Z",
    });
  });

  test("the order date still wins", () => {
    expect(purchaseTitle(provenanceTitleSource({ ...purchase, orderDate: "2026-07-15T00:00:00.000Z" }, line))).toEqual({
      kind: "untitled",
      date: "2026-07-15T00:00:00.000Z",
    });
  });

  test("an older read without the purchase's createdAt falls back to the line's", () => {
    const { createdAt: _unused, ...older } = purchase;
    void _unused;
    expect(provenanceTitleSource(older, line).createdAt).toBe(line.createdAt);
  });
});
