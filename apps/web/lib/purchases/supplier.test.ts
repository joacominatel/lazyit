import { describe, expect, test } from "bun:test";
import type { Supplier } from "@lazyit/shared";
import {
  resolveSupplier,
  supplierDraftFrom,
  taxIdOwner,
  toCreateSupplier,
  toUpdateSupplier,
} from "./supplier";

const supplier = (id: string, name: string, patch: Partial<Supplier> = {}): Supplier => ({
  id,
  name,
  taxId: null,
  website: null,
  salesContactName: null,
  salesContactEmail: null,
  salesContactPhone: null,
  supportContactName: null,
  supportContactEmail: null,
  supportContactPhone: null,
  notes: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
  ...patch,
});

describe("resolveSupplier (ADR-0099 D-D: no uniqueness, create inline)", () => {
  const compumundo = supplier("s1", "Compumundo");
  const compudata = supplier("s2", "Compudata");

  test("blank text is no supplier", () => {
    expect(resolveSupplier("  ", [compumundo])).toEqual({ kind: "none" });
  });

  test("the exact trimmed name picks the supplier; a partial match does not", () => {
    expect(resolveSupplier(" Compumundo ", [compumundo, compudata])).toEqual({ kind: "existing", id: "s1" });
    expect(resolveSupplier("Compu", [compumundo, compudata])).toEqual({ kind: "new", name: "Compu" });
  });

  test("another spelling is a new supplier — the hint offered it, the operator kept theirs", () => {
    expect(resolveSupplier("COMPUMUNDO", [compumundo])).toEqual({ kind: "new", name: "COMPUMUNDO" });
  });

  test("same-named suppliers ask which one, then honour the pick", () => {
    const twin = supplier("s3", "Compumundo", { taxId: "30-1" });
    expect(resolveSupplier("Compumundo", [compumundo, twin])).toEqual({
      kind: "ambiguous",
      choices: [compumundo, twin],
    });
    expect(resolveSupplier("Compumundo", [compumundo, twin], null, "s3")).toEqual({
      kind: "existing",
      id: "s3",
    });
  });

  test("the purchase keeps its own supplier while the name is unchanged, even if archived", () => {
    expect(resolveSupplier("Old Corp", [], { id: "s9", name: "Old Corp" })).toEqual({
      kind: "existing",
      id: "s9",
    });
  });
});

describe("taxIdOwner", () => {
  test("finds another supplier with the tax ID, ignoring case and itself", () => {
    const owner = supplier("s1", "Compumundo", { taxId: "30-71234567-9" });
    expect(taxIdOwner(" 30-71234567-9 ", [owner])).toBe(owner);
    expect(taxIdOwner("30-71234567-9", [owner], "s1")).toBeNull();
    expect(taxIdOwner("", [owner])).toBeNull();
  });
});

describe("supplier payloads", () => {
  test("create sends the name and the filled fields only", () => {
    expect(
      toCreateSupplier({ name: " Compumundo ", taxId: "", salesContactEmail: " ventas@compumundo.com " }),
    ).toEqual({ name: "Compumundo", salesContactEmail: "ventas@compumundo.com" });
  });

  test("update sends only changes and clears with null", () => {
    const saved = supplier("s1", "Compumundo", { taxId: "30-1", notes: "x" });
    expect(toUpdateSupplier(supplierDraftFrom(saved), saved)).toBeNull();
    expect(toUpdateSupplier({ ...supplierDraftFrom(saved), taxId: "", website: "compumundo.com" }, saved)).toEqual({
      taxId: null,
      website: "compumundo.com",
    });
  });
});
