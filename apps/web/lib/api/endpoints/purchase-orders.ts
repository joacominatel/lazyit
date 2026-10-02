import type {
  ApplyLicense,
  ApplyLicenseResult,
  AssetPurchaseProvenance,
  CancelRemainingUnits,
  CreatePurchaseFromAssets,
  CreatePurchaseFromAssetsResult,
  CreatePurchaseOrder,
  CreatePurchaseOrderLine,
  LicenseProposal,
  LinkAssetsResult,
  LinkAssetsToLine,
  PendingPurchaseLinePage,
  PurchaseExtractionDraft,
  PurchaseExtractionStatus,
  PurchaseLinkPreview,
  PurchaseOrder,
  PurchaseOrderDetail,
  PurchaseOrderEventPage,
  PurchaseOrderLine,
  PurchaseOrderListPage,
  PurchaseOrderReceiptFilter,
  PurchaseOrderStatus,
  ReceiveFromLine,
  ReceiveFromLineResult,
  ReceiveStockFromLine,
  ReceiveStockFromLineResult,
  UnlinkAssetsResult,
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

// ── Flows (#1473): receive, link, unlink, cancel remaining, pending units, provenance ──────────────────

/** The line endpoints' base path. */
function linePath(id: string, lineId: string): string {
  return `${BASE}/${encodeURIComponent(id)}/lines/${encodeURIComponent(lineId)}`;
}

/**
 * Generate assets from an `ASSET` line (`purchaseOrder:write` + `asset:write`). Partial success like bulk
 * receive: a 201 with `{ created, failed }` even when units fail, plus `overReceived` and the line as it
 * reads afterwards. Every body field is an override of the purchase's prefill for this receive only.
 */
export function receiveFromLine(
  id: string,
  lineId: string,
  data: ReceiveFromLine,
): Promise<ReceiveFromLineResult> {
  return apiFetch<ReceiveFromLineResult>(`${linePath(id, lineId)}/receive`, {
    method: "POST",
    body: data,
  });
}

/**
 * Receive units of a `CONSUMABLE` line into its consumable's stock (`purchaseOrder:write` +
 * `consumable:write`, #1476): ONE `IN` movement through the consumables ledger, carrying the line. The
 * note becomes the movement's notes — readable by anyone who can see that consumable's movements.
 * Over-receipt is allowed and flagged (`overReceived`).
 */
export function receiveStockFromLine(
  id: string,
  lineId: string,
  data: ReceiveStockFromLine,
): Promise<ReceiveStockFromLineResult> {
  return apiFetch<ReceiveStockFromLineResult>(`${linePath(id, lineId)}/receive-stock`, {
    method: "POST",
    body: data,
  });
}

/**
 * The per-field diff of linking these assets to a line (`purchaseOrder:read` + `asset:read`). A read with
 * a body, because the ids may be many.
 */
export function getLinkPreview(
  id: string,
  lineId: string,
  assetIds: string[],
  signal?: AbortSignal,
): Promise<PurchaseLinkPreview> {
  return apiFetch<PurchaseLinkPreview>(`${linePath(id, lineId)}/link-preview`, {
    method: "POST",
    body: { assetIds },
    signal,
  });
}

/** Link existing assets to a line, copying only the listed values. Partial success with a reason each. */
export function linkAssetsToLine(
  id: string,
  lineId: string,
  data: LinkAssetsToLine,
): Promise<LinkAssetsResult> {
  return apiFetch<LinkAssetsResult>(`${linePath(id, lineId)}/link-assets`, {
    method: "POST",
    body: data,
  });
}

/** Unlink assets from a line. Their purchase values are never cleared. */
export function unlinkAssetsFromLine(
  id: string,
  lineId: string,
  assetIds: string[],
): Promise<UnlinkAssetsResult> {
  return apiFetch<UnlinkAssetsResult>(`${linePath(id, lineId)}/unlink-assets`, {
    method: "POST",
    body: { assetIds },
  });
}

/** Cancel units that will not arrive (default: every pending unit); 409 when nothing is pending. */
export function cancelRemainingUnits(
  id: string,
  lineId: string,
  data: CancelRemainingUnits,
): Promise<PurchaseOrderLine> {
  return apiFetch<PurchaseOrderLine>(`${linePath(id, lineId)}/cancel-remaining`, {
    method: "POST",
    body: data,
  });
}

/**
 * The *Pending units* list: countable lines with units still pending on live purchases that are neither
 * draft nor cancelled, oldest purchase first, each with its purchase header.
 */
export function getPendingLines(
  { supplierId, limit, offset }: { supplierId?: string; limit?: number; offset?: number } = {},
  signal?: AbortSignal,
): Promise<PendingPurchaseLinePage> {
  const qs = new URLSearchParams();
  if (supplierId) qs.set("supplierId", supplierId);
  if (limit !== undefined) qs.set("limit", String(limit));
  if (offset !== undefined) qs.set("offset", String(offset));
  const search = qs.toString();
  return apiFetch<PendingPurchaseLinePage>(
    search ? `${BASE}/pending-lines?${search}` : `${BASE}/pending-lines`,
    { signal },
  );
}

/**
 * An asset's purchase provenance (`asset:read` + `purchaseOrder:read`, ADR-0099 D-A): 403 without the
 * purchase permission, 404 when the asset is not linked. Callers ask only when both hold.
 */
export function getAssetPurchase(assetId: string, signal?: AbortSignal): Promise<AssetPurchaseProvenance> {
  return apiFetch<AssetPurchaseProvenance>(`/assets/${encodeURIComponent(assetId)}/purchase`, { signal });
}

// ── Phase 2 (#1477): document extraction, license lines, create from assets ─────────────────────────────

/**
 * Whether *Read this document* can be offered to the caller (`purchaseOrder:read`): available, or the reason
 * it is not (`AI_DISABLED`, `EXTRACTION_DISABLED`, `PROVIDER_UNSUPPORTED`, `NOT_PERMITTED`), the document types
 * the configured provider reads and the caps. The web never extracts unless this says `available`.
 */
export function getExtractionStatus(signal?: AbortSignal): Promise<PurchaseExtractionStatus> {
  return apiFetch<PurchaseExtractionStatus>(`${BASE}/extraction/status`, { signal });
}

/**
 * Send a document attached to the purchase to the configured AI provider and return the DRAFT
 * (`purchaseOrder:write` + `ai:use`, people only). Saves nothing to the purchase: the person reviews the draft
 * and saves through the ordinary routes. Refusals carry a `code` (409 unavailable, 422 the document, 429
 * budget, 502 the provider, 504 the deadline); the document stays attached on every one.
 */
export function extractPurchaseDocument(id: string, attachmentId: string): Promise<PurchaseExtractionDraft> {
  return apiFetch<PurchaseExtractionDraft>(
    `${BASE}/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}/extract`,
    { method: "POST" },
  );
}

/**
 * What applying a `LICENSE` line would do (`purchaseOrder:read` + `application:read`): the application's
 * current seats and renewal, the line's pending seats as the default to add, and the warnings. Writes nothing.
 */
export function getLicenseProposal(id: string, lineId: string, signal?: AbortSignal): Promise<LicenseProposal> {
  return apiFetch<LicenseProposal>(`${linePath(id, lineId)}/license-proposal`, { signal });
}

/**
 * Apply a `LICENSE` line to its application — explicit, never automatic (`purchaseOrder:write` +
 * `application:write`): adds the confirmed seats and/or sets the renewal date through the application's own
 * write path, and counts the seats as applied on the line. Over-application is allowed and flagged.
 */
export function applyLicense(id: string, lineId: string, data: ApplyLicense): Promise<ApplyLicenseResult> {
  return apiFetch<ApplyLicenseResult>(`${linePath(id, lineId)}/apply-license`, { method: "POST", body: data });
}

/**
 * Create one purchase from selected existing assets (`purchaseOrder:write` + `asset:write`): a line per
 * model (or name), the assets linked, no other asset field changed. Partial success with a reason per asset
 * left out; a 409 with nothing created when none can be linked.
 */
export function createPurchaseFromAssets(data: CreatePurchaseFromAssets): Promise<CreatePurchaseFromAssetsResult> {
  return apiFetch<CreatePurchaseFromAssetsResult>(`${BASE}/from-assets`, { method: "POST", body: data });
}
