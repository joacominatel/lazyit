import { describe, expect, test } from "bun:test";
import { CreatePurchaseOrderSchema, type PurchaseOrder, type PurchaseOrderLine } from "@lazyit/shared";
import {
  emptyHeaderDraft,
  emptyLineDraft,
  headerDraftFrom,
  isBlankLine,
  type LineDraft,
  lineDraftFrom,
  toCreatePurchase,
  toUpdateLine,
  toUpdatePurchase,
} from "./payload";

const line = (patch: Partial<LineDraft>): LineDraft => ({ ...emptyLineDraft("l1"), ...patch });

describe("toCreatePurchase — minimal payloads (ADR-0099 D-D)", () => {
  test("a reference alone is a whole purchase; blank fields are not sent", () => {
    const result = toCreatePurchase({ ...emptyHeaderDraft(), reference: " OC 1 " }, undefined, [], "es");
    expect(result).toEqual({ ok: true, payload: { status: "ORDERED", reference: "OC 1" } });
    if (result.ok) expect(CreatePurchaseOrderSchema.safeParse(result.payload).success).toBe(true);
  });

  test("a supplier alone is a whole purchase", () => {
    const result = toCreatePurchase(emptyHeaderDraft(), "cksupplier0000000000000000", [], "es");
    expect(result).toEqual({
      ok: true,
      payload: { status: "ORDERED", supplierId: "cksupplier0000000000000000" },
    });
  });

  test("one line with only a description; quantity 1 and kind ASSET are left to the API", () => {
    const result = toCreatePurchase(emptyHeaderDraft(), undefined, [line({ description: "Flete" })], "es");
    expect(result).toEqual({ ok: true, payload: { status: "ORDERED", lines: [{ description: "Flete" }] } });
  });

  test("nothing that identifies the purchase is refused before the request", () => {
    const result = toCreatePurchase(emptyHeaderDraft(), undefined, [emptyLineDraft("x")], "es");
    expect(result).toEqual({ ok: false, lineErrors: {}, unidentified: true });
  });

  test("blank lines are ignored, the quantity at its default does not count as typing", () => {
    expect(isBlankLine(emptyLineDraft("x"))).toBe(true);
    expect(isBlankLine(line({ quantity: "2" }))).toBe(false);
    const result = toCreatePurchase(
      { ...emptyHeaderDraft(), reference: "OC 2" },
      undefined,
      [emptyLineDraft("a"), line({ key: "b", description: "Monitor" }), emptyLineDraft("c")],
      "en",
    );
    expect(result.ok && result.payload.lines).toEqual([{ description: "Monitor" }]);
  });

  test("dates become UTC midnight; status and filled header fields are carried", () => {
    const result = toCreatePurchase(
      {
        ...emptyHeaderDraft(),
        reference: "OC 3",
        status: "DRAFT",
        currency: " u$s ",
        orderDate: "2026-03-03",
        company: "Acme",
        invoiceNumbers: "A 0003-12345, A 0003-12388",
      },
      undefined,
      [],
      "es",
    );
    expect(result).toEqual({
      ok: true,
      payload: {
        status: "DRAFT",
        reference: "OC 3",
        currency: "u$s",
        orderDate: "2026-03-03T00:00:00.000Z",
        company: "Acme",
        invoiceNumbers: "A 0003-12345, A 0003-12388",
      },
    });
  });
});

describe("toCreatePurchase — lines and money per locale (ADR-0100 §5)", () => {
  test("es reads 1.412.500,00 and en reads 1,412,500.00 as the same amount", () => {
    const es = toCreatePurchase(emptyHeaderDraft(), undefined, [line({ description: "NB", unitPrice: "1.412.500,00", quantity: "4" })], "es");
    const en = toCreatePurchase(emptyHeaderDraft(), undefined, [line({ description: "NB", unitPrice: "1,412,500.00", quantity: "4" })], "en");
    expect(es.ok && es.payload.lines).toEqual([{ description: "NB", quantity: 4, unitPrice: 141250000 }]);
    expect(en).toEqual(es);
  });

  test("price 0 is free, distinct from blank (unknown)", () => {
    const result = toCreatePurchase(emptyHeaderDraft(), undefined, [line({ description: "Gift", unitPrice: "0" })], "es");
    expect(result.ok && result.payload.lines).toEqual([{ description: "Gift", unitPrice: 0 }]);
  });

  test("model fields go on an asset line and are dropped on an OTHER line", () => {
    const filled = {
      manufacturerText: "Lenovo",
      modelText: "E14 G5",
      assetModelId: "ckmodel000000000000000000",
      warrantyMonths: "36",
    };
    const asset = toCreatePurchase(emptyHeaderDraft(), undefined, [line({ description: "NB", ...filled })], "es");
    expect(asset.ok && asset.payload.lines).toEqual([
      {
        description: "NB",
        manufacturerText: "Lenovo",
        modelText: "E14 G5",
        assetModelId: "ckmodel000000000000000000",
        warrantyMonths: 36,
      },
    ]);
    const other = toCreatePurchase(emptyHeaderDraft(), undefined, [line({ description: "Flete", kind: "OTHER", ...filled })], "es");
    expect(other.ok && other.payload.lines).toEqual([{ description: "Flete", kind: "OTHER" }]);
  });

  test("a refused amount, a bad quantity or a missing description are errors on that line", () => {
    const result = toCreatePurchase(
      { ...emptyHeaderDraft(), reference: "OC" },
      undefined,
      [line({ key: "a", description: "", unitPrice: "1,234.56", quantity: "0", warrantyMonths: "2000" })],
      "es",
    );
    expect(result).toEqual({
      ok: false,
      unidentified: false,
      lineErrors: {
        a: { description: "required", quantity: "invalid", unitPrice: "invalid", warrantyMonths: "invalid" },
      },
    });
  });
});

const purchase: PurchaseOrder = {
  id: "ckpurchase000000000000000",
  reference: "OC 1",
  supplierId: "cksupplier0000000000000000",
  status: "ORDERED",
  currency: "ARS",
  orderDate: "2026-03-03T00:00:00.000Z",
  expectedDate: null,
  deliveryLocationId: null,
  company: null,
  invoiceNumbers: null,
  invoiceDate: null,
  notes: "keep",
  createdAt: "2026-03-03T10:00:00.000Z",
  updatedAt: "2026-03-03T10:00:00.000Z",
  deletedAt: null,
};

describe("toUpdatePurchase", () => {
  test("an untouched form sends nothing", () => {
    expect(toUpdatePurchase(headerDraftFrom(purchase), purchase.supplierId, purchase)).toBeNull();
  });

  test("only changed fields; a cleared field is null", () => {
    const header = { ...headerDraftFrom(purchase), currency: "", company: "Acme", orderDate: "", notes: "keep" };
    expect(toUpdatePurchase(header, null, purchase)).toEqual({
      supplierId: null,
      currency: null,
      orderDate: null,
      company: "Acme",
    });
  });
});

const savedLine: PurchaseOrderLine = {
  id: "ckline0000000000000000000",
  purchaseOrderId: purchase.id,
  position: 0,
  kind: "ASSET",
  description: "NB LEN E14",
  manufacturerText: "Lenovo",
  modelText: null,
  assetModelId: null,
  quantity: 4,
  unitPrice: 141250000,
  cancelledQuantity: 0,
  warrantyMonths: 36,
  createdAt: purchase.createdAt,
  updatedAt: purchase.createdAt,
  deletedAt: null,
  receivedQuantity: 0,
  pendingQuantity: 4,
  receiptState: "NONE",
  lineTotal: 565000000,
};

describe("toUpdateLine", () => {
  test("a saved line round-trips through the form without changes", () => {
    expect(lineDraftFrom(savedLine, "es").unitPrice).toBe("1.412.500");
    expect(toUpdateLine(lineDraftFrom(savedLine, "es"), savedLine, "es")).toEqual({ ok: true, payload: null });
  });

  test("a price change and a cleared price", () => {
    const draft = lineDraftFrom(savedLine, "en");
    expect(toUpdateLine({ ...draft, unitPrice: "1,380,000" }, savedLine, "en")).toEqual({
      ok: true,
      payload: { unitPrice: 138000000 },
    });
    expect(toUpdateLine({ ...draft, unitPrice: "" }, savedLine, "en")).toEqual({
      ok: true,
      payload: { unitPrice: null },
    });
  });

  test("switching to OTHER clears the model fields", () => {
    const draft = { ...lineDraftFrom(savedLine, "es"), kind: "OTHER" as const };
    expect(toUpdateLine(draft, savedLine, "es")).toEqual({
      ok: true,
      payload: { kind: "OTHER", manufacturerText: null, warrantyMonths: null },
    });
  });
});
