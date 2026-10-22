import { describe, expect, test } from "bun:test";
import {
  CreateSupplierSchema,
  SUPPLIER_MERGE_FIELDS,
  SupplierDetailSchema,
  SupplierMergeSchema,
  SupplierSchema,
  SupplierYearlyTotalSchema,
  UpdateSupplierSchema,
} from "./supplier";

describe("CreateSupplierSchema (ADR-0099 §2, CEO decision D-D)", () => {
  test("only the name is required", () => {
    expect(CreateSupplierSchema.parse({ name: "  Compumundo " })).toEqual({ name: "Compumundo" });
    expect(CreateSupplierSchema.safeParse({}).success).toBe(false);
    expect(CreateSupplierSchema.safeParse({ name: " " }).success).toBe(false);
  });

  test("blank optional fields are absent; the support contact is separate from sales", () => {
    const parsed = CreateSupplierSchema.parse({
      name: "Compumundo",
      taxId: "",
      salesContactEmail: "ventas@compumundo.example",
      supportContactEmail: "rma@compumundo.example",
    });
    expect(parsed.taxId).toBeUndefined();
    expect(parsed.salesContactEmail).toBe("ventas@compumundo.example");
    expect(parsed.supportContactEmail).toBe("rma@compumundo.example");
  });

  test("a website must be a host or http(s) — a script URL is refused", () => {
    expect(CreateSupplierSchema.safeParse({ name: "A", website: "compumundo.example" }).success).toBe(true);
    expect(CreateSupplierSchema.safeParse({ name: "A", website: "https://compumundo.example" }).success).toBe(true);
    expect(CreateSupplierSchema.safeParse({ name: "A", website: "javascript:alert(1)" }).success).toBe(false);
  });

  test("a malformed contact email is refused", () => {
    expect(CreateSupplierSchema.safeParse({ name: "A", salesContactEmail: "not-an-email" }).success).toBe(false);
  });
});

describe("UpdateSupplierSchema", () => {
  test("null clears an optional field; the name cannot be cleared; an empty PATCH is refused", () => {
    expect(UpdateSupplierSchema.parse({ taxId: null })).toEqual({ taxId: null });
    expect(UpdateSupplierSchema.safeParse({ name: null }).success).toBe(false);
    expect(UpdateSupplierSchema.safeParse({}).success).toBe(false);
  });
});

describe("Supplier merge contract (#1496)", () => {
  test("the merge body is just the duplicate's id, a cuid; nothing else is accepted", () => {
    expect(SupplierMergeSchema.safeParse({ sourceId: "clsupplier00000000000002" }).success).toBe(true);
    expect(SupplierMergeSchema.safeParse({ sourceId: "not-an-id" }).success).toBe(false);
    expect(SupplierMergeSchema.safeParse({}).success).toBe(false);
    expect(
      SupplierMergeSchema.safeParse({ sourceId: "clsupplier00000000000002", overwrite: true }).success,
    ).toBe(false);
  });

  test("the mergeable fields are exactly the supplier's editable fields minus the name", () => {
    const editable = Object.keys(SupplierSchema.shape).filter(
      (key) => !["id", "name", "createdAt", "updatedAt", "deletedAt"].includes(key),
    );
    expect([...SUPPLIER_MERGE_FIELDS].sort()).toEqual(editable.sort());
  });

  test("a merge can fill every optional field but never the name", () => {
    expect(SUPPLIER_MERGE_FIELDS).not.toContain("name");
    expect(SUPPLIER_MERGE_FIELDS).toContain("taxId");
    expect(SUPPLIER_MERGE_FIELDS).toContain("supportContactEmail");
  });
});

describe("SupplierDetailSchema — yearly totals (#1500, ADR-0099 §5)", () => {
  const row = {
    id: "clsupplier00000000000001",
    name: "Compumundo",
    taxId: null,
    website: null,
    salesContactName: null,
    salesContactEmail: null,
    salesContactPhone: null,
    supportContactName: null,
    supportContactEmail: null,
    supportContactPhone: null,
    notes: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    deletedAt: null,
  };

  test("a row without yearlyTotals still parses — the field is additive and optional", () => {
    expect(SupplierDetailSchema.parse(row).yearlyTotals).toBeUndefined();
  });

  test("an older reader (SupplierSchema) tolerates the new field", () => {
    expect(SupplierSchema.safeParse({ ...row, yearlyTotals: [] }).success).toBe(true);
  });

  test("one entry per year and label; null currency and null amount are allowed", () => {
    const totals = [
      { year: 2026, currency: "USD", amount: 150_000, unpricedLines: 1, purchaseCount: 2 },
      { year: 2026, currency: null, amount: null, unpricedLines: 0, purchaseCount: 1 },
    ];
    expect(SupplierDetailSchema.parse({ ...row, yearlyTotals: totals }).yearlyTotals).toEqual(totals);
  });

  test("the money and counters stay integers within their bounds", () => {
    const ok = { year: 2026, currency: "ARS", amount: 1, unpricedLines: 0, purchaseCount: 1 };
    expect(SupplierYearlyTotalSchema.safeParse(ok).success).toBe(true);
    expect(SupplierYearlyTotalSchema.safeParse({ ...ok, amount: 1.5 }).success).toBe(false);
    expect(SupplierYearlyTotalSchema.safeParse({ ...ok, amount: Number.MAX_SAFE_INTEGER + 2 }).success).toBe(false);
    expect(SupplierYearlyTotalSchema.safeParse({ ...ok, purchaseCount: -1 }).success).toBe(false);
    expect(SupplierYearlyTotalSchema.safeParse({ ...ok, year: undefined }).success).toBe(false);
  });
});
