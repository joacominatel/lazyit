import type {
  CreateSupplier,
  Supplier,
  SupplierListPage,
  SupplierMergePreview,
  SupplierMergeResult,
  UpdateSupplier,
} from "@lazyit/shared";
import { apiFetch } from "../client";
import { createCrudEndpoints } from "../crud-endpoints";

/**
 * Data-access for Suppliers (ADR-0099 §2) — part of the Purchases permission domain
 * (`purchaseOrder:*`). Names and tax IDs are not unique; a likely duplicate is a hint, never a refusal.
 */

const BASE = "/suppliers";

const crud = createCrudEndpoints<Supplier, CreateSupplier, UpdateSupplier>(BASE);
export const getSupplier = crud.get;
export const createSupplier = crud.create;
export const updateSupplier = crud.update;
export const deleteSupplier = crud.remove;

/** Restore an archived supplier (ADMIN). */
export function restoreSupplier(id: string): Promise<Supplier> {
  return apiFetch<Supplier>(`${BASE}/${id}/restore`, { method: "POST" });
}

/**
 * What merging the duplicate `sourceId` into `targetId` (the supplier that stays) would do — the purchases
 * that move, the fields filled and the ones kept as they are. ADMIN; writes nothing.
 */
export function getSupplierMergePreview(
  targetId: string,
  sourceId: string,
  signal?: AbortSignal,
): Promise<SupplierMergePreview> {
  const qs = new URLSearchParams({ sourceId });
  return apiFetch<SupplierMergePreview>(`${BASE}/${targetId}/merge-preview?${qs.toString()}`, { signal });
}

/** Merge the duplicate `sourceId` into `targetId`, which stays; the duplicate is archived (ADMIN, #1496). */
export function mergeSupplier(targetId: string, sourceId: string): Promise<SupplierMergeResult> {
  return apiFetch<SupplierMergeResult>(`${BASE}/${targetId}/merge`, {
    method: "POST",
    body: { sourceId },
  });
}

/**
 * Server-side params for `GET /suppliers`. `q` matches name, tax ID and the contact names and emails;
 * `sort` is allowlisted to `name|createdAt|updatedAt`. `deleted: "only"` is the ADMIN-only archived view.
 */
export interface SupplierListParams {
  q?: string;
  sort?: string;
  dir?: "asc" | "desc";
  limit?: number;
  offset?: number;
  deleted?: "only";
}

export function getSuppliers(
  params: SupplierListParams = {},
  signal?: AbortSignal,
): Promise<SupplierListPage> {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.sort) {
    qs.set("sort", params.sort);
    if (params.dir) qs.set("dir", params.dir);
  }
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  if (params.deleted) qs.set("deleted", params.deleted);
  const search = qs.toString();
  return apiFetch<SupplierListPage>(search ? `${BASE}?${search}` : BASE, { signal });
}
