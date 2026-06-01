import type {
  Consumable,
  ConsumableListPage,
  ConsumableMovement,
  ConsumableMovementQuery,
  CreateConsumable,
  CreateConsumableMovement,
  UpdateConsumable,
} from "@lazyit/shared";
import { apiFetch } from "../client";
import { createCrudEndpoints } from "../crud-endpoints";

/**
 * Data-access for Consumable — stock-counted supplies (ADR-0034). CRUD via the factory (writes use
 * the raw `Consumable`; `currentStock` is never set here — only movements change it). The list is
 * raw (no expanded read), so the screen joins the category client-side. Stock changes go through the
 * nested movement ledger.
 */

const BASE = "/consumables";

const crud = createCrudEndpoints<Consumable, CreateConsumable, UpdateConsumable>(
  BASE,
);
export const getConsumable = crud.get;
export const createConsumable = crud.create;
export const updateConsumable = crud.update;
export const deleteConsumable = crud.remove;

/**
 * Server-side params for the consumable list (#104). `q` matches name/sku/description; `sort` is
 * allowlisted to `name|sku|currentStock|createdAt|updatedAt` (unknown → 400); `lowStock=true` keeps
 * only items at or below their reorder threshold (`currentStock <= minStock`). Category is NOT a
 * server param — the screen filters it client-side over the page. `limit`/`offset` thread the
 * pagination window (ADR-0030).
 */
export interface ConsumableListParams {
  q?: string;
  sort?: string;
  dir?: "asc" | "desc";
  lowStock?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * List non-deleted consumables, paged. `GET /consumables` returns a `Page<Consumable>` envelope; we
 * return the whole envelope (`items` + `total`/`limit`/`offset`) so the list can paginate. Only
 * server-supported params are forwarded (extra client-only filter keys are ignored).
 */
export function getConsumables(
  params: ConsumableListParams = {},
): Promise<ConsumableListPage> {
  const qs = new URLSearchParams();
  if (params.q) qs.set("q", params.q);
  if (params.sort) {
    qs.set("sort", params.sort);
    if (params.dir) qs.set("dir", params.dir);
  }
  if (params.lowStock) qs.set("lowStock", "true");
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  const search = qs.toString();
  return apiFetch<ConsumableListPage>(search ? `${BASE}?${search}` : BASE);
}

/** A consumable's stock movement ledger (newest first), optionally filtered by type / date range. */
export function getConsumableMovements(
  consumableId: string,
  query: ConsumableMovementQuery = {},
): Promise<ConsumableMovement[]> {
  const params = new URLSearchParams();
  if (query.type) params.set("type", query.type);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  const qs = params.toString();
  return apiFetch<ConsumableMovement[]>(
    qs
      ? `${BASE}/${consumableId}/movements?${qs}`
      : `${BASE}/${consumableId}/movements`,
  );
}

/**
 * Record a stock movement (IN adds, OUT subtracts, ADJUSTMENT sets the absolute count). `quantity`
 * is positive; the direction is the `type`. The API maintains `currentStock` transactionally and
 * returns 409 if an OUT would go negative. `performedById` is set from the authenticated user (Bearer token, ADR-0038).
 */
export function createConsumableMovement(
  consumableId: string,
  data: CreateConsumableMovement,
): Promise<ConsumableMovement> {
  return apiFetch<ConsumableMovement>(`${BASE}/${consumableId}/movements`, {
    method: "POST",
    body: data,
  });
}
