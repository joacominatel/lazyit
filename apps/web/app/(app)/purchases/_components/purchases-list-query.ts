import {
  PURCHASE_ORDER_STATUSES,
  PurchaseOrderReceiptFilterSchema,
  type PurchaseOrderStatus,
} from "@lazyit/shared";
import type { PurchaseOrderListParams } from "@/lib/api/endpoints/purchase-orders";
import type { DerivedListState } from "@/lib/hooks/list-params-url";

/**
 * URL filters of the purchases list. The list opens on the purchases still waiting for units
 * (`receipt=PENDING`); "ALL" lifts a filter. `archived` drives the ADMIN-only archived view.
 */
export const PURCHASE_FILTER_DEFAULTS = {
  receipt: "PENDING",
  status: "ALL",
  supplier: "ALL",
  archived: "ALL",
} as const;

export const PURCHASE_LIST_OPTIONS = {
  filters: PURCHASE_FILTER_DEFAULTS,
  filterValidators: {
    receipt: ["ALL", ...PurchaseOrderReceiptFilterSchema.options],
    status: PURCHASE_ORDER_STATUSES,
  },
};

/** URL state → the `GET /purchase-orders` params. */
export function derivePurchaseParams(
  state: Pick<DerivedListState, "q" | "sort" | "dir" | "offset" | "limit" | "filters">,
  opts: { isAdmin: boolean },
): PurchaseOrderListParams {
  const { q, sort, dir, offset, limit, filters } = state;
  const receipt = PurchaseOrderReceiptFilterSchema.safeParse(filters.receipt);
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
