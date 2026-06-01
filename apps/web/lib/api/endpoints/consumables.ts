import type {
  Consumable,
  ConsumableMovement,
  ConsumableMovementQuery,
  CreateConsumable,
  CreateConsumableMovement,
  Page,
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

export interface ConsumableFilters {
  /** Server-side: only items at or below their reorder threshold (`currentStock <= minStock`). */
  lowStock?: boolean;
}

/**
 * List non-deleted consumables, optionally only low-stock ones. `GET /consumables`
 * is paginated (ADR-0030 amendment): unwrap the `Page<Consumable>` envelope to its
 * `items` for the current array-based screen. The list-chain wave will consume the
 * full envelope + server-side params (sort/q/pagination).
 */
export function getConsumables(
  filters: ConsumableFilters = {},
): Promise<Consumable[]> {
  const params = new URLSearchParams();
  if (filters.lowStock) params.set("lowStock", "true");
  const qs = params.toString();
  return apiFetch<Page<Consumable>>(qs ? `${BASE}?${qs}` : BASE).then(
    (page) => page.items,
  );
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
