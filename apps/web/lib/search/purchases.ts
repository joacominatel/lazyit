/**
 * Purchases and suppliers in the global search palette (#1499, ADR-0099) — pure, so the rules are tested
 * without React. The palette translates what these return.
 */

import type { Permission, PurchaseHit, SearchEntity, SupplierHit } from "@lazyit/shared";
import type { PurchaseTitleSource } from "@/lib/purchases/display";

/**
 * The extra read permission a search entity needs before the palette offers its filter chip. The API
 * already omits these entities for a caller without it (no hit, no count); hiding the chip keeps the
 * palette from offering a filter that can only ever come back empty.
 */
const ENTITY_PERMISSION: Partial<Record<SearchEntity, Permission>> = {
  purchases: "purchaseOrder:read",
  suppliers: "purchaseOrder:read",
};

/** The entities whose filter chip the viewer gets, in the given (canonical) order. */
export function visibleSearchEntities(
  entities: readonly SearchEntity[],
  can: (permission: Permission) => boolean,
): SearchEntity[] {
  return entities.filter((entity) => {
    const permission = ENTITY_PERMISSION[entity];
    return permission === undefined || can(permission);
  });
}

/** A purchase hit opens the purchase's page. */
export function purchaseHitHref(hit: Pick<PurchaseHit, "id">): string {
  return `/purchases/${hit.id}`;
}

/** A supplier hit opens the supplier's page. */
export function supplierHitHref(hit: Pick<SupplierHit, "id">): string {
  return `/purchases/suppliers/${hit.id}`;
}

/** The hit as the purchase title rule reads it (the same title the purchases list shows). */
export function purchaseHitTitleSource(hit: PurchaseHit): PurchaseTitleSource {
  return {
    reference: hit.reference,
    supplier: hit.supplierName ? { name: hit.supplierName } : null,
    orderDate: hit.orderDate,
    createdAt: hit.createdAt,
  };
}

/**
 * The muted second column of a purchase row: what the title does not already say. A purchase titled by
 * its reference shows its supplier (else its invoice numbers); one titled *Supplier · date* or
 * *Purchase · date* shows its invoice numbers. Nothing when there is nothing more to say.
 */
export function purchaseHitSecondary(hit: PurchaseHit): string | undefined {
  const supplier = hit.supplierName?.trim() || undefined;
  const invoices = hit.invoiceNumbers?.trim() || undefined;
  if (hit.reference?.trim()) return supplier ?? invoices;
  return invoices;
}
