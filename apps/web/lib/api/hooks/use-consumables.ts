import type { ConsumableMovementQuery } from "@lazyit/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  type ConsumableDeliveryParams,
  type ConsumableListParams,
  getConsumable,
  getConsumableDeliveries,
  getConsumableMovements,
  getConsumables,
} from "../endpoints/consumables";

/**
 * Query keys for the Consumable resource. Hand-written so a consumable's movement ledger nests under
 * its detail — recording a movement invalidates `all`, refetching both the stock and the ledger.
 */
export const consumableKeys = {
  all: ["consumables"] as const,
  lists: () => [...consumableKeys.all, "list"] as const,
  list: (params: ConsumableListParams) =>
    [...consumableKeys.all, "list", params] as const,
  detail: (id: string) => [...consumableKeys.all, "detail", id] as const,
  movements: (id: string, query: ConsumableMovementQuery) =>
    [...consumableKeys.all, "detail", id, "movements", query] as const,
  /**
   * Deliveries to one target (ADR-0098). Under `all`, so every movement write (which invalidates `all`)
   * refreshes the user / asset / location deliveries panels and the offboarding sheet too.
   */
  deliveries: () => [...consumableKeys.all, "deliveries"] as const,
  deliveryList: (params: ConsumableDeliveryParams) =>
    [...consumableKeys.all, "deliveries", params] as const,
};

/**
 * The Consumables list page: a single page with server-side `q`/`sort`/`lowStock` and paging (returns
 * the `Page<Consumable>` envelope so the page can paginate + sort). `category` is a server filter
 * too (#824). `keepPreviousData` holds the current page while the next query
 * resolves, avoiding a skeleton flash on each search/filter/page change.
 */
export function useConsumables(params: ConsumableListParams = {}) {
  return useQuery({
    queryKey: consumableKeys.list(params),
    queryFn: ({ signal }) => getConsumables(params, signal),
    placeholderData: keepPreviousData,
  });
}

/** Fetch a single consumable by id; idle until an id is provided. */
export function useConsumable(id: string | undefined) {
  return useQuery({
    queryKey: consumableKeys.detail(id ?? ""),
    queryFn: () => getConsumable(id as string),
    enabled: Boolean(id),
  });
}

/** A consumable's stock movements (newest first), optionally filtered. */
export function useConsumableMovements(
  id: string | undefined,
  query: ConsumableMovementQuery = {},
) {
  return useQuery({
    queryKey: consumableKeys.movements(id ?? "", query),
    queryFn: () => getConsumableMovements(id as string, query),
    enabled: Boolean(id),
  });
}

/**
 * The deliveries made to one user / asset / location (ADR-0098), a `Page` envelope, newest first.
 * `enabled` lets a caller hold the read (e.g. until a sheet opens). A 403 (the caller lacks the target
 * domain's read permission) is a 4xx, so the app-wide retry predicate settles it at once — callers read
 * `error` and hide the section instead of showing a failure.
 */
export function useConsumableDeliveries(
  params: ConsumableDeliveryParams,
  enabled = true,
) {
  return useQuery({
    queryKey: consumableKeys.deliveryList(params),
    queryFn: ({ signal }) => getConsumableDeliveries(params, signal),
    enabled,
    placeholderData: keepPreviousData,
  });
}
