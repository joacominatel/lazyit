import type {
  CreatePurchaseOrder,
  CreatePurchaseOrderLine,
  PurchaseOrder,
  PurchaseOrderDetail,
  PurchaseOrderEventPage,
  PurchaseOrderLine,
  PurchaseOrderListPage,
  PurchaseOrderReceiptFilter,
  PurchaseOrderStatus,
  UpdatePurchaseOrder,
  UpdatePurchaseOrderLine,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for Purchases (ADR-0099) — the ONLY place that talks to `apiFetch` for purchase orders,
 * their lines and their activity log. Every read is gated by `purchaseOrder:read`, writes by `:write`,
 * archive/restore by `:delete` (ADMIN). Totals and the receipt state arrive derived; the web never
 * computes them for a saved purchase.
 */

const BASE = "/purchase-orders";

/**
 * Server-side params for `GET /purchase-orders`. `q` matches reference, invoice numbers, supplier name
 * and line descriptions; `status` OR-combines stored statuses; `receipt` is one derived state or
 * `PENDING` (at least one unit still pending on a purchase that is not cancelled). `sort` is allowlisted
 * server-side (unknown → 400). `deleted: "only"` is the ADMIN-only archived view.
 */
export interface PurchaseOrderListParams {
  q?: string;
  status?: PurchaseOrderStatus[];
  supplierId?: string;
  receipt?: PurchaseOrderReceiptFilter;
  sort?: string;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
  deleted?: "only";
}

export function getPurchaseOrders(
  params: PurchaseOrderListParams = {},
  signal?: AbortSignal,
): Promise<PurchaseOrderListPage> {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.status && params.status.length > 0) qs.set("status", params.status.join(","));
  if (params.supplierId) qs.set("supplierId", params.supplierId);
  if (params.receipt) qs.set("receipt", params.receipt);
  if (params.sort) {
    qs.set("sort", params.sort);
    if (params.dir) qs.set("dir", params.dir);
  }
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  if (params.deleted) qs.set("deleted", params.deleted);
  const search = qs.toString();
  return apiFetch<PurchaseOrderListPage>(search ? `${BASE}?${search}` : BASE, { signal });
}

/** One live purchase with its lines and every derived value; 404 when missing or archived. */
export function getPurchaseOrder(id: string): Promise<PurchaseOrderDetail> {
  return apiFetch<PurchaseOrderDetail>(`${BASE}/${id}`);
}

/** Create a purchase, lines inline. It must carry a supplier, a reference or at least one line. */
export function createPurchaseOrder(data: CreatePurchaseOrder): Promise<PurchaseOrderDetail> {
  return apiFetch<PurchaseOrderDetail>(BASE, { method: "POST", body: data });
}

/** Update the header (`null` clears a field). Lines change through their own endpoints. */
export function updatePurchaseOrder(
  id: string,
  data: UpdatePurchaseOrder,
): Promise<PurchaseOrderDetail> {
  return apiFetch<PurchaseOrderDetail>(`${BASE}/${id}`, { method: "PATCH", body: data });
}

/** Archive (soft delete, ADMIN). Every asset link is kept. */
export function deletePurchaseOrder(id: string): Promise<PurchaseOrder> {
  return apiFetch<PurchaseOrder>(`${BASE}/${id}`, { method: "DELETE" });
}

/** Restore an archived purchase (ADMIN). */
export function restorePurchaseOrder(id: string): Promise<PurchaseOrderDetail> {
  return apiFetch<PurchaseOrderDetail>(`${BASE}/${id}/restore`, { method: "POST" });
}

/** One page of a purchase's append-only activity log, newest first. */
export function getPurchaseOrderEvents(
  id: string,
  { limit, offset }: { limit?: number; offset?: number } = {},
): Promise<PurchaseOrderEventPage> {
  const qs = new URLSearchParams();
  if (limit !== undefined) qs.set("limit", String(limit));
  if (offset !== undefined) qs.set("offset", String(offset));
  const search = qs.toString();
  return apiFetch<PurchaseOrderEventPage>(
    search ? `${BASE}/${id}/events?${search}` : `${BASE}/${id}/events`,
  );
}

/** Add a line; only the description is required. */
export function addPurchaseOrderLine(
  id: string,
  data: CreatePurchaseOrderLine,
): Promise<PurchaseOrderLine> {
  return apiFetch<PurchaseOrderLine>(`${BASE}/${id}/lines`, { method: "POST", body: data });
}

/** Update a line (`null` clears a field). */
export function updatePurchaseOrderLine(
  id: string,
  lineId: string,
  data: UpdatePurchaseOrderLine,
): Promise<PurchaseOrderLine> {
  return apiFetch<PurchaseOrderLine>(`${BASE}/${id}/lines/${lineId}`, {
    method: "PATCH",
    body: data,
  });
}

/** Remove a line — only while no asset is linked to it (409 otherwise). */
export function removePurchaseOrderLine(id: string, lineId: string): Promise<PurchaseOrderLine> {
  return apiFetch<PurchaseOrderLine>(`${BASE}/${id}/lines/${lineId}`, { method: "DELETE" });
}
