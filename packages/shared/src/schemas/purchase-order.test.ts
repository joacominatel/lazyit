import { describe, expect, test } from "bun:test";
import { MONEY_MAX } from "./primitives";
import {
  CreatePurchaseOrderLineSchema,
  CreatePurchaseOrderSchema,
  PurchaseOrderLineSchema,
  PurchaseOrderSchema,
  UpdatePurchaseOrderLineSchema,
  UpdatePurchaseOrderSchema,
} from "./purchase-order";

const ID = "ckpurchase000000000000001";
const ISO = "2026-10-02T12:00:00.000Z";

describe("CreatePurchaseOrderSchema — light entry (ADR-0099, CEO decision D-D)", () => {
  test("a purchase with only one line is valid", () => {
    expect(CreatePurchaseOrderSchema.safeParse({ lines: [{ description: "Laptop" }] }).success).toBe(true);
  });

  test("a purchase with only a reference or only a supplier is valid", () => {
    expect(CreatePurchaseOrderSchema.safeParse({ reference: "OC-1" }).success).toBe(true);
    expect(CreatePurchaseOrderSchema.safeParse({ supplierId: ID }).success).toBe(true);
  });

  test("a purchase that identifies nothing is refused", () => {
    expect(CreatePurchaseOrderSchema.safeParse({}).success).toBe(false);
    expect(CreatePurchaseOrderSchema.safeParse({ notes: "x", lines: [] }).success).toBe(false);
    // A blank reference is absent, so it identifies nothing either.
    expect(CreatePurchaseOrderSchema.safeParse({ reference: "   " }).success).toBe(false);
  });

  test("the currency is a free-text label: trimmed, any spelling, length-bounded", () => {
    const parsed = CreatePurchaseOrderSchema.parse({ reference: "OC-1", currency: "  u$s " });
    expect(parsed.currency).toBe("u$s");
    expect(CreatePurchaseOrderSchema.parse({ reference: "OC-1", currency: "" }).currency).toBeUndefined();
    expect(CreatePurchaseOrderSchema.safeParse({ reference: "OC-1", currency: "x".repeat(33) }).success).toBe(false);
  });

  test("status is validated on write against DRAFT | ORDERED | CANCELLED", () => {
    expect(CreatePurchaseOrderSchema.safeParse({ reference: "OC-1", status: "DRAFT" }).success).toBe(true);
    expect(CreatePurchaseOrderSchema.safeParse({ reference: "OC-1", status: "RECEIVED" }).success).toBe(false);
  });

  test("unknown keys are refused (strict body)", () => {
    expect(CreatePurchaseOrderSchema.safeParse({ reference: "OC-1", total: 5 }).success).toBe(false);
  });
});

describe("CreatePurchaseOrderLineSchema", () => {
  test("only the description is required", () => {
    const line = CreatePurchaseOrderLineSchema.parse({ description: "Monitor 27" });
    expect(line).toEqual({ description: "Monitor 27" });
  });

  test("kind is ASSET | OTHER | CONSUMABLE | LICENSE on write (LICENSE since Phase 2, #1477)", () => {
    expect(CreatePurchaseOrderLineSchema.safeParse({ description: "Shipping", kind: "OTHER" }).success).toBe(true);
    expect(CreatePurchaseOrderLineSchema.safeParse({ description: "Toner", kind: "CONSUMABLE" }).success).toBe(true);
    expect(CreatePurchaseOrderLineSchema.safeParse({ description: "Office", kind: "LICENSE" }).success).toBe(true);
    expect(CreatePurchaseOrderLineSchema.safeParse({ description: "Lease", kind: "LEASE" }).success).toBe(false);
  });

  test("an application is named on a LICENSE line only, and stays optional there (#1477)", () => {
    expect(
      CreatePurchaseOrderLineSchema.safeParse({ description: "M365 E3", kind: "LICENSE", applicationId: ID }).success,
    ).toBe(true);
    expect(CreatePurchaseOrderLineSchema.safeParse({ description: "M365 E3", kind: "LICENSE" }).success).toBe(true);
    expect(CreatePurchaseOrderLineSchema.safeParse({ description: "M365 E3", applicationId: ID }).success).toBe(false);
    expect(
      CreatePurchaseOrderLineSchema.safeParse({ description: "Toner", kind: "CONSUMABLE", applicationId: ID }).success,
    ).toBe(false);
    expect(UpdatePurchaseOrderLineSchema.parse({ applicationId: null })).toEqual({ applicationId: null });
  });

  test("a consumable is named on a CONSUMABLE line only, and stays optional there", () => {
    expect(
      CreatePurchaseOrderLineSchema.safeParse({ description: "Toner", kind: "CONSUMABLE", consumableId: ID }).success,
    ).toBe(true);
    expect(CreatePurchaseOrderLineSchema.safeParse({ description: "Toner", kind: "CONSUMABLE" }).success).toBe(true);
    // The default kind is ASSET: a consumable on it is refused, as on an explicit ASSET or OTHER line.
    expect(CreatePurchaseOrderLineSchema.safeParse({ description: "Toner", consumableId: ID }).success).toBe(false);
    expect(
      CreatePurchaseOrderLineSchema.safeParse({ description: "Toner", kind: "OTHER", consumableId: ID }).success,
    ).toBe(false);
  });

  test("a unit price above int4 is accepted (64-bit money, ADR-0100); 0 is valid; negative is not", () => {
    expect(CreatePurchaseOrderLineSchema.parse({ description: "Server", unitPrice: 3_000_000_000 }).unitPrice).toBe(
      3_000_000_000,
    );
    expect(CreatePurchaseOrderLineSchema.safeParse({ description: "Freebie", unitPrice: 0 }).success).toBe(true);
    expect(CreatePurchaseOrderLineSchema.safeParse({ description: "x", unitPrice: -1 }).success).toBe(false);
    expect(CreatePurchaseOrderLineSchema.safeParse({ description: "x", unitPrice: MONEY_MAX + 1 }).success).toBe(false);
  });

  test("quantity is at least 1 and cancelled cannot exceed it (default quantity 1)", () => {
    expect(CreatePurchaseOrderLineSchema.safeParse({ description: "x", quantity: 0 }).success).toBe(false);
    expect(CreatePurchaseOrderLineSchema.safeParse({ description: "x", cancelledQuantity: 2 }).success).toBe(false);
    expect(
      CreatePurchaseOrderLineSchema.safeParse({ description: "x", quantity: 4, cancelledQuantity: 2 }).success,
    ).toBe(true);
  });
});

describe("update schemas", () => {
  test("an empty PATCH is refused; null clears an optional field", () => {
    expect(UpdatePurchaseOrderSchema.safeParse({}).success).toBe(false);
    expect(UpdatePurchaseOrderSchema.parse({ currency: null, reference: null })).toEqual({
      currency: null,
      reference: null,
    });
    expect(UpdatePurchaseOrderLineSchema.parse({ unitPrice: null })).toEqual({ unitPrice: null });
    expect(UpdatePurchaseOrderLineSchema.parse({ consumableId: null })).toEqual({ consumableId: null });
    expect(UpdatePurchaseOrderLineSchema.parse({ consumableId: ID })).toEqual({ consumableId: ID });
    expect(UpdatePurchaseOrderLineSchema.safeParse({ description: null }).success).toBe(false);
  });
});

describe("read schemas tolerate values a newer build may write (ADR-0099 §14)", () => {
  test("an unknown status and kind still parse", () => {
    expect(
      PurchaseOrderSchema.safeParse({
        id: ID,
        reference: null,
        supplierId: null,
        status: "CLOSED_BY_A_NEWER_BUILD",
        currency: null,
        orderDate: null,
        expectedDate: null,
        deliveryLocationId: null,
        company: null,
        invoiceNumbers: null,
        invoiceDate: null,
        notes: null,
        createdAt: ISO,
        updatedAt: ISO,
        deletedAt: null,
      }).success,
    ).toBe(true);
    expect(
      PurchaseOrderLineSchema.safeParse({
        id: ID,
        purchaseOrderId: ID,
        position: 0,
        kind: "LICENSE",
        description: "Office seats",
        manufacturerText: null,
        modelText: null,
        assetModelId: null,
        quantity: 10,
        unitPrice: null,
        cancelledQuantity: 0,
        warrantyMonths: null,
        createdAt: ISO,
        updatedAt: ISO,
        deletedAt: null,
        receivedQuantity: 0,
        pendingQuantity: 0,
        receiptState: null,
        lineTotal: null,
      }).success,
    ).toBe(true);
  });
});
