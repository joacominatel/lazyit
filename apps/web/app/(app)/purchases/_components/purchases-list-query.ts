import {
  PURCHASE_ORDER_STATUSES,
  PurchaseOrderReceiptFilterSchema,
  type PurchaseOrderStatus,
} from "@lazyit/shared";
import type { PurchaseOrderListParams } from "@/lib/api/endpoints/purchase-orders";
import type { DerivedListState } from "@/lib/hooks/list-params-url";

/**
 * URL filters of the purchases list. The list opens on every purchase (#1507, ADR-0099 Phase 1 web as
 * amended); the receipt filter narrows it, to the purchases still waiting for units among others. "ALL"
 * lifts a filter. `archived` drives the ADMIN-only archived view.
 */
export const PURCHASE_FILTER_DEFAULTS = {
  receipt: "ALL",
  status: "ALL",
  supplier: "ALL",
  archived: "ALL",
} as const;

/**
 * Newest first: by the day the purchase was recorded, the order the API defaults to. Sorting by order date
 * would put every purchase without one first (`GET /purchase-orders` has no nulls-last nor a fallback to the
 * recorded date), so it stays a column the operator chooses.
 */
export const PURCHASE_LIST_OPTIONS = {
  filters: PURCHASE_FILTER_DEFAULTS,
  defaultSort: "createdAt",
  defaultDir: "desc" as const,
  filterValidators: {
    receipt: ["ALL", ...PurchaseOrderReceiptFilterSchema.options],
    status: PURCHASE_ORDER_STATUSES,
  },
};

/**
 * Whether the receipt filter is lifted: the archived view lists every archived purchase, and a
 * *Cancelled* status filter would otherwise meet a `PENDING` receipt filter, which excludes cancelled
 * purchases and so always reads empty.
 */
export function receiptFilterLifted(
  filters: Record<string, string>,
  opts: { isAdmin: boolean },
): boolean {
  return (opts.isAdmin && filters.archived === "only") || filters.status === "CANCELLED";
}

/** URL state → the `GET /purchase-orders` params. */
export function derivePurchaseParams(
  state: Pick<DerivedListState, "q" | "sort" | "dir" | "offset" | "limit" | "filters">,
  opts: { isAdmin: boolean },
): PurchaseOrderListParams {
  const { q, sort, dir, offset, limit, filters } = state;
  const receipt = PurchaseOrderReceiptFilterSchema.safeParse(
    receiptFilterLifted(filters, opts) ? "ALL" : filters.receipt,
  );
  return {
    q: q || undefined,
    sort,
    dir: sort ? dir : undefined,
    receipt: receipt.success ? receipt.data : undefined,
    status:
      filters.status !== "ALL" ? [filters.status as PurchaseOrderStatus] : undefined,
    supplierId: filters.supplier !== "ALL" ? filters.supplier : undefined,
    limit,
    offset,
    deleted: opts.isAdmin && filters.archived === "only" ? "only" : undefined,
  };
}
