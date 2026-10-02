import { describe, expect, test } from "bun:test";
import {
  PURCHASE_EXTRACTION_ERROR_CODES,
  PURCHASE_EXTRACTION_UNAVAILABLE_REASONS,
  PurchaseExtractionDraftSchema,
  PurchaseExtractionStatusSchema,
} from "./purchase-extraction";

const PO = "ckpurchase000000000000001";
const ATT = "ckattachment0000000000001";
const blank = { value: null, evidence: null };

function draft(over: Record<string, unknown> = {}) {
  return {
    extractionId: "ext_1",
    purchaseOrderId: PO,
    attachmentId: ATT,
    header: {
      supplierName: { value: "Compumundo S.A.", evidence: { text: "COMPUMUNDO S.A.", page: 1 } },
      supplierTaxId: blank,
      reference: blank,
      currency: { value: "$", evidence: { text: "$", page: 1 } },
      orderDate: blank,
      invoiceNumbers: blank,
      invoiceDate: { value: "2026-03-10T00:00:00.000Z", evidence: { text: "10/03/2026", page: 1 } },
    },
    lines: [
      {
        kind: "ASSET",
        description: { value: "NB LEN E14 G5", evidence: { text: "NB LEN E14 G5", page: 1 } },
        manufacturerText: blank,
        modelText: blank,
        quantity: { value: 4, evidence: { text: "4", page: 1 } },
        unitPrice: { value: 141_250_000, evidence: { text: "1.412.500,00", page: 1 } },
        lineTotal: blank,
        warrantyMonths: blank,
      },
    ],
    totals: { linesTotal: 565_000_000, incompleteLines: 0, net: blank, tax: blank, gross: blank },
    matches: { supplier: null, lineModels: [null] },
    warnings: [{ code: "CURRENCY_AMBIGUOUS", path: "header.currency" }],
    ...over,
  };
}

describe("PurchaseExtractionDraftSchema (#1477)", () => {
  test("a draft with blanks (null value and evidence) parses — blanks over guesses", () => {
    expect(PurchaseExtractionDraftSchema.safeParse(draft()).success).toBe(true);
  });

  test("amounts are minor units: never negative, never fractional", () => {
    const bad = draft();
    (bad.lines as { unitPrice: unknown }[])[0]!.unitPrice = { value: 1.5, evidence: null };
    expect(PurchaseExtractionDraftSchema.safeParse(bad).success).toBe(false);
  });

  test("a warning code a newer API adds still parses (open string on read)", () => {
    expect(
      PurchaseExtractionDraftSchema.safeParse(draft({ warnings: [{ code: "SOMETHING_NEW", path: "lines" }] }))
        .success,
    ).toBe(true);
  });
});

describe("PurchaseExtractionStatusSchema (#1477)", () => {
  test("unavailable with a reason, available with the readable types", () => {
    expect(
      PurchaseExtractionStatusSchema.safeParse({
        available: false,
        reason: "EXTRACTION_DISABLED",
        mediaTypes: [],
        maxBytes: 1,
        maxPages: 1,
        disclosure: "d",
      }).success,
    ).toBe(true);
  });

  test("every unavailable reason is also an extract refusal code", () => {
    for (const reason of PURCHASE_EXTRACTION_UNAVAILABLE_REASONS) {
      expect(PURCHASE_EXTRACTION_ERROR_CODES).toContain(reason);
    }
  });
});
