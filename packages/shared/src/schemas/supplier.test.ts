import { describe, expect, test } from "bun:test";
import { CreateSupplierSchema, UpdateSupplierSchema } from "./supplier";

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
