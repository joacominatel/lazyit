import { describe, expect, test } from "bun:test";
import {
  CreatePurchaseOrderLineSchema,
  type PurchaseExtractionDraft,
  type PurchaseExtractionLine,
  type PurchaseOrderDetail,
  type PurchaseOrderLine,
  UpdatePurchaseOrderSchema,
} from "@lazyit/shared";
import {
  buildReview,
  buildReviewPayload,
  checkCount,
  editProposal,
  editSupplier,
  proposalAction,
  type ReviewState,
  totalsCheck,
} from "./extraction-review";

const ev = (text: string, page = 1) => ({ text, page });
const read = <T,>(value: T, text: string) => ({ value, evidence: ev(text) });
const blank = { value: null, evidence: null };

const SUPPLIER = "cksupplier000000000000000";
const MODEL = "ckmodel000000000000000000";

function draftLine(patch: Partial<PurchaseExtractionLine> = {}): PurchaseExtractionLine {
  return {
    kind: "ASSET",
    description: read("NB LEN E14 G5", "NB LEN E14 G5"),
    manufacturerText: read("Lenovo", "Lenovo"),
    modelText: read("E14 Gen 5", "E14 Gen 5"),
    quantity: read(4, "4"),
    unitPrice: read(141250000, "1.412.500,00"),
    lineTotal: read(565000000, "5.650.000,00"),
    warrantyMonths: blank,
    ...patch,
  };
}

function draft(patch: Partial<PurchaseExtractionDraft> = {}): PurchaseExtractionDraft {
  return {
    extractionId: "ext_1",
    purchaseOrderId: "ckpurchase000000000000000",
    attachmentId: "ckattachment0000000000000",
    header: {
      supplierName: read("COMPUMUNDO S.A.", "COMPUMUNDO S.A."),
      supplierTaxId: read("30-71234567-9", "CUIT 30-71234567-9"),
      reference: read("OC 4471", "OC 4471"),
      currency: read("ARS", "ARS"),
      orderDate: blank,
      invoiceNumbers: read("A 0003-00012345", "A 0003-00012345"),
      invoiceDate: read("2026-03-10T00:00:00.000Z", "10/03/2026"),
    },
    lines: [draftLine(), draftLine({ kind: "OTHER", description: read("Flete", "Flete"), manufacturerText: blank, modelText: blank, quantity: read(1, "1"), unitPrice: blank, lineTotal: blank })],
    totals: {
      linesTotal: 565000000,
      incompleteLines: 1,
      net: read(567500000, "5.675.000,00"),
      tax: blank,
      gross: blank,
    },
    matches: {
      supplier: { id: SUPPLIER, name: "Compumundo", by: "TAX_ID" },
      lineModels: [{ id: MODEL, name: "ThinkPad E14 Gen 5", manufacturer: "Lenovo", by: "LINE_MEMORY" }, null],
    },
    warnings: [
      { code: "DATE_AMBIGUOUS", path: "header.invoiceDate" },
      { code: "TOTAL_MISMATCH", path: "totals", detail: { linesTotal: 565000000, net: 567500000, gross: null } },
    ],
    ...patch,
  };
}

function purchase(patch: Partial<PurchaseOrderDetail> = {}): PurchaseOrderDetail {
  return {
    id: "ckpurchase000000000000000",
    supplierId: null,
    supplier: null,
    reference: null,
    status: "ORDERED",
    currency: null,
    orderDate: null,
    expectedDate: null,
    deliveryLocationId: null,
    company: null,
    invoiceNumbers: null,
    invoiceDate: null,
    notes: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    deletedAt: null,
    lines: [],
    totals: [],
    receipt: null,
    ...patch,
  } as PurchaseOrderDetail;
}

function savedLine(patch: Partial<PurchaseOrderLine> = {}): PurchaseOrderLine {
  return {
    id: "ckline0000000000000000000",
    purchaseOrderId: "ckpurchase000000000000000",
    position: 0,
    kind: "ASSET",
    description: "NB len e14  g5",
    manufacturerText: null,
    modelText: null,
    assetModelId: null,
    quantity: 4,
    unitPrice: 115000000,
    cancelledQuantity: 0,
    warrantyMonths: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    deletedAt: null,
    receivedQuantity: 0,
    pendingQuantity: 4,
    receiptState: "NONE",
    lineTotal: 460000000,
    ...patch,
  };
}

const header = (state: ReviewState, field: string) => state.header.find((item) => item.field === field)!;

describe("proposalAction — the client-side diff", () => {
  test("an empty field is filled, a different value replaced, an equal one left alone", () => {
    expect(proposalAction("reference", "", "OC 1")).toBe("fill");
    expect(proposalAction("reference", "OC 0", "OC 1")).toBe("replace");
    expect(proposalAction("reference", " OC 1 ", "OC 1")).toBe("same");
    expect(proposalAction("reference", "OC 1", "")).toBe("unread");
  });

  test("a currency label is compared trimmed and case-insensitively (ADR-0099 §5)", () => {
    expect(proposalAction("currency", "usd ", "USD")).toBe("same");
  });
});

describe("buildReview — draft → form", () => {
  test("values read fill the empty purchase, pre-checked; nulls stay blank and unchecked", () => {
    const state = buildReview(draft(), purchase(), "factura.pdf", "es");
    expect(header(state, "reference")).toMatchObject({ proposed: "OC 4471", read: true, checked: true });
    expect(header(state, "orderDate")).toMatchObject({ proposed: "", read: false, checked: false });
    expect(header(state, "invoiceDate")).toMatchObject({
      proposed: "2026-03-10",
      evidence: ev("10/03/2026"),
      warnings: ["DATE_AMBIGUOUS"],
      checked: true,
    });
  });

  test("amounts arrive in minor units and read in the viewer's locale; a quantity not read stays blank, never 1", () => {
    const state = buildReview(
      draft({ lines: [draftLine({ quantity: blank })] }),
      purchase(),
      "factura.pdf",
      "es",
    );
    const [line] = state.lines;
    expect(line!.draft.unitPrice).toBe("1.412.500");
    expect(line!.draft.quantity).toBe("");
    expect(line!.unread).toContain("quantity");
    expect(line!.draft.warrantyMonths).toBe("");
    expect(buildReview(draft(), purchase(), "factura.pdf", "en").lines[0]!.draft.unitPrice).toBe("1,412,500");
  });

  test("the model matched by line memory is mapped on an asset line; nothing is mapped on other kinds", () => {
    const state = buildReview(draft(), purchase(), "factura.pdf", "es");
    expect(state.lines[0]!.draft.assetModelId).toBe(MODEL);
    expect(state.lines[1]!.draft).toMatchObject({ kind: "OTHER", assetModelId: "" });
  });

  test("a line whose kind was not read starts as an asset line and says so", () => {
    const state = buildReview(draft({ lines: [draftLine({ kind: null })] }), purchase(), "f.pdf", "es");
    expect(state.lines[0]).toMatchObject({ kindRead: false, draft: { kind: "ASSET" } });
  });

  test("a line nobody could name is not added until a description is typed", () => {
    const state = buildReview(draft({ lines: [draftLine({ description: blank })] }), purchase(), "f.pdf", "es");
    expect(state.lines[0]!.checked).toBe(false);
  });

  test("the matched supplier is proposed by its own name, picked by id", () => {
    const state = buildReview(draft(), purchase(), "factura.pdf", "es");
    expect(state.supplier).toMatchObject({ text: "Compumundo", chosenId: SUPPLIER, checked: true, readTaxId: "30-71234567-9" });
  });
});

describe("buildReview — proposed changes on a purchase that has data", () => {
  const existing = purchase({
    supplierId: "cksupplierother0000000000",
    supplier: { id: "cksupplierother0000000000", name: "Otro", deletedAt: null } as PurchaseOrderDetail["supplier"],
    reference: "OC 4470",
    currency: "USD",
    invoiceNumbers: null,
    lines: [savedLine()],
  });

  test("filling an empty field is pre-checked; replacing a value never is", () => {
    const state = buildReview(draft(), existing, "factura.pdf", "es");
    expect(header(state, "invoiceNumbers")).toMatchObject({ current: "", checked: true });
    expect(header(state, "reference")).toMatchObject({ current: "OC 4470", proposed: "OC 4471", checked: false });
    expect(header(state, "currency")).toMatchObject({ current: "USD", proposed: "ARS", checked: false });
    expect(state.supplier.checked).toBe(false);
  });

  test("a document line with the same description proposes changes to that line, field by field", () => {
    const state = buildReview(draft(), existing, "factura.pdf", "es");
    const [matched, added] = state.lines;
    expect(matched!.target?.id).toBe("ckline0000000000000000000");
    expect(matched!.fields.find((f) => f.field === "quantity")).toMatchObject({ current: "4", proposed: "4", checked: false });
    expect(matched!.fields.find((f) => f.field === "unitPrice")).toMatchObject({
      current: "1.150.000",
      proposed: "1.412.500",
      checked: false,
    });
    expect(added!.target).toBeNull();
    expect(added!.checked).toBe(true);
  });

  test("the purchase's own supplier matched again is no change", () => {
    const same = purchase({
      supplierId: SUPPLIER,
      supplier: { id: SUPPLIER, name: "Compumundo", deletedAt: null } as PurchaseOrderDetail["supplier"],
    });
    expect(buildReview(draft(), same, "factura.pdf", "es").supplier.checked).toBe(false);
  });

  test("the holder of New purchase from a document is filled like an empty purchase", () => {
    const holder = purchase({ reference: "factura", status: "DRAFT" });
    const state = buildReview(draft(), holder, "factura.pdf", "es");
    expect(state.holder).toBe(true);
    expect(state.markOrdered).toBe(true);
    expect(header(state, "reference")).toMatchObject({ current: "", checked: true });
    // A purchase someone typed the same reference into is not a holder once it has a supplier.
    const typed = purchase({ reference: "factura", supplierId: SUPPLIER });
    expect(buildReview(draft(), typed, "factura.pdf", "es").holder).toBe(false);
  });
});

describe("editing a proposal", () => {
  test("typing a value checks it; emptying it unchecks it", () => {
    const state = buildReview(draft(), purchase({ reference: "OC 4470" }), "f.pdf", "es");
    const reference = header(state, "reference");
    expect(reference.checked).toBe(false);
    expect(editProposal(reference, "OC 4472").checked).toBe(true);
    expect(editProposal(reference, "").checked).toBe(false);
  });

  test("choosing to create the supplier as read drops the match", () => {
    const state = buildReview(draft(), purchase(), "f.pdf", "es");
    expect(editSupplier(state.supplier, "COMPUMUNDO S.A.", "")).toMatchObject({ chosenId: "", checked: true });
  });
});

describe("buildReviewPayload — only what the person confirmed", () => {
  test("a new purchase: header, supplier and lines, all through the ordinary write shapes", () => {
    const state = buildReview(draft(), purchase(), "f.pdf", "es");
    state.lines[1]!.checked = true;
    const result = buildReviewPayload(state, "es");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.header).toEqual({
      reference: "OC 4471",
      currency: "ARS",
      invoiceNumbers: "A 0003-00012345",
      invoiceDate: "2026-03-10T00:00:00.000Z",
    });
    expect(UpdatePurchaseOrderSchema.safeParse(result.payload.header).success).toBe(true);
    expect(result.payload.supplier).toEqual({ text: "Compumundo", chosenId: SUPPLIER, taxId: null });
    expect(result.payload.addLines.map((l) => l.line)).toEqual([
      {
        description: "NB LEN E14 G5",
        quantity: 4,
        unitPrice: 141250000,
        manufacturerText: "Lenovo",
        modelText: "E14 Gen 5",
        assetModelId: MODEL,
      },
      { kind: "OTHER", description: "Flete" },
    ]);
    for (const { line } of result.payload.addLines) {
      expect(CreatePurchaseOrderLineSchema.safeParse(line).success).toBe(true);
    }
    expect(result.changes).toBe(7);
  });

  test("a new supplier as read is created with the tax ID read", () => {
    const state = buildReview(draft({ matches: { supplier: null, lineModels: [] } }), purchase(), "f.pdf", "es");
    const result = buildReviewPayload(state, "es");
    expect(result.ok && result.payload.supplier).toEqual({
      text: "COMPUMUNDO S.A.",
      chosenId: "",
      taxId: "30-71234567-9",
    });
  });

  test("a blank is never sent, so nothing is cleared — even when checked", () => {
    const state = buildReview(draft(), purchase({ orderDate: "2026-01-01T00:00:00.000Z" }), "f.pdf", "es");
    header(state, "orderDate").checked = true;
    const result = buildReviewPayload(state, "es");
    expect(result.ok && result.payload.header && "orderDate" in result.payload.header).toBe(false);
  });

  test("replacements apply only when ticked", () => {
    const state = buildReview(draft(), purchase({ reference: "OC 4470" }), "f.pdf", "es");
    const unticked = buildReviewPayload(state, "es");
    expect(unticked.ok && unticked.payload.header?.reference).toBeUndefined();
    header(state, "reference").checked = true;
    const ticked = buildReviewPayload(state, "es");
    expect(ticked.ok && ticked.payload.header?.reference).toBe("OC 4471");
  });

  test("a new line whose quantity was not read must be typed (blanks over guesses)", () => {
    const state = buildReview(draft({ lines: [draftLine({ quantity: blank })] }), purchase(), "f.pdf", "es");
    expect(buildReviewPayload(state, "es")).toEqual({
      ok: false,
      headerErrors: {},
      lineErrors: { 0: { quantity: "invalid" } },
    });
    state.lines[0]!.draft.quantity = "3";
    const fixed = buildReviewPayload(state, "es");
    expect(fixed.ok && fixed.payload.addLines[0]!.line.quantity).toBe(3);
  });

  test("an unknown price stays unknown (ADR-0099 §2)", () => {
    const state = buildReview(draft({ lines: [draftLine({ unitPrice: blank })] }), purchase(), "f.pdf", "es");
    const result = buildReviewPayload(state, "es");
    expect(result.ok && "unitPrice" in result.payload.addLines[0]!.line).toBe(false);
  });

  test("a matched line sends only its ticked field changes, as minor units", () => {
    const state = buildReview(draft(), purchase({ lines: [savedLine({ unitPrice: null })] }), "f.pdf", "es");
    const result = buildReviewPayload(state, "es");
    expect(result.ok && result.payload.lineUpdates).toEqual([
      { index: 0, lineId: "ckline0000000000000000000", data: { unitPrice: 141250000 } },
    ]);
  });

  test("the holder is marked as ordered with the review", () => {
    const state = buildReview(draft(), purchase({ reference: "factura", status: "DRAFT" }), "factura.pdf", "es");
    const result = buildReviewPayload(state, "es");
    expect(result.ok && result.payload.header?.status).toBe("ORDERED");
  });
});

describe("totalsCheck — lines against the printed net and gross", () => {
  test("a mismatch says by how much, and counts the lines it could not add", () => {
    const state = buildReview(draft(), purchase(), "f.pdf", "es");
    expect(totalsCheck(state.lines, draft().totals, "es")).toEqual({
      linesTotal: 565000000,
      incomplete: 1,
      net: 567500000,
      gross: null,
      state: "mismatch",
      difference: -2500000,
    });
  });

  test("fixing the blank line makes it match", () => {
    const state = buildReview(draft(), purchase(), "f.pdf", "es");
    state.lines[1]!.draft.unitPrice = "25.000";
    expect(totalsCheck(state.lines, draft().totals, "es")).toMatchObject({ state: "match", incomplete: 0 });
  });

  test("nothing printed to compare with is unknown, not a match", () => {
    const state = buildReview(draft(), purchase(), "f.pdf", "es");
    expect(totalsCheck(state.lines, { net: blank, gross: blank }, "es").state).toBe("unknown");
  });
});

describe("checkCount", () => {
  test("counts the values the API flagged", () => {
    const state = buildReview(
      draft({
        warnings: [
          { code: "DATE_AMBIGUOUS", path: "header.invoiceDate" },
          { code: "AMOUNT_AMBIGUOUS", path: "lines.1.unitPrice" },
          { code: "TOTAL_MISMATCH", path: "totals" },
        ],
      }),
      purchase(),
      "f.pdf",
      "es",
    );
    expect(checkCount(state)).toBe(2);
    expect(state.lines[1]!.warnings.unitPrice).toEqual(["AMOUNT_AMBIGUOUS"]);
  });
});
