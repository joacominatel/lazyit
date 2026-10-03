import { describe, expect, test } from "bun:test";
import { type Permission, type PurchaseHit, SEARCH_ENTITIES } from "@lazyit/shared";
import { purchaseTitle } from "@/lib/purchases/display";
import {
  purchaseHitHref,
  purchaseHitSecondary,
  purchaseHitTitleSource,
  supplierHitHref,
  visibleSearchEntities,
} from "./purchases";

const hit = (over: Partial<PurchaseHit> = {}): PurchaseHit => ({
  id: "po1",
  reference: "OC-4512",
  supplierName: "Compumundo",
  invoiceNumbers: "A-0001",
  status: "ORDERED",
  orderDate: "2026-09-12T00:00:00.000Z",
  createdAt: "2026-09-12T10:30:00.000Z",
  ...over,
});

const holding =
  (...held: Permission[]) =>
  (permission: Permission) =>
    held.includes(permission);

describe("purchases in global search (#1499)", () => {
  test("a viewer with purchaseOrder:read gets the Purchases and Suppliers chips", () => {
    const visible = visibleSearchEntities(SEARCH_ENTITIES, holding("purchaseOrder:read"));
    expect(visible).toContain("purchases");
    expect(visible).toContain("suppliers");
    expect(visible).toEqual([...SEARCH_ENTITIES]);
  });

  test("without purchaseOrder:read (a Viewer by default) both chips are hidden, the rest stay", () => {
    const visible = visibleSearchEntities(SEARCH_ENTITIES, holding());
    expect(visible).not.toContain("purchases");
    expect(visible).not.toContain("suppliers");
    expect(visible).toEqual(SEARCH_ENTITIES.filter((e) => e !== "purchases" && e !== "suppliers"));
  });

  test("a purchase hit links to its page, a supplier hit to the supplier page", () => {
    expect(purchaseHitHref({ id: "po1" })).toBe("/purchases/po1");
    expect(supplierHitHref({ id: "s1" })).toBe("/purchases/suppliers/s1");
  });

  test("a hit is titled like the purchases list: reference, else supplier · date, else purchase · date", () => {
    expect(purchaseTitle(purchaseHitTitleSource(hit()))).toEqual({
      kind: "reference",
      reference: "OC-4512",
    });
    expect(purchaseTitle(purchaseHitTitleSource(hit({ reference: null })))).toEqual({
      kind: "supplier",
      supplier: "Compumundo",
      date: "2026-09-12T00:00:00.000Z",
    });
    expect(
      purchaseTitle(
        purchaseHitTitleSource(hit({ reference: null, supplierName: null, orderDate: null })),
      ),
    ).toEqual({ kind: "untitled", date: "2026-09-12T10:30:00.000Z" });
  });

  test("the second column says what the title does not", () => {
    expect(purchaseHitSecondary(hit())).toBe("Compumundo");
    expect(purchaseHitSecondary(hit({ supplierName: null }))).toBe("A-0001");
    // Titled by the supplier: the supplier is not repeated, the invoice numbers are shown.
    expect(purchaseHitSecondary(hit({ reference: null }))).toBe("A-0001");
    expect(purchaseHitSecondary(hit({ reference: null, invoiceNumbers: "  " }))).toBeUndefined();
  });
});
