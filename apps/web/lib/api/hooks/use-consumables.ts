import type { ConsumableMovementQuery } from "@lazyit/shared";
import { useQuery } from "@tanstack/react-query";
import {
  type ConsumableFilters,
  getConsumable,
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
  list: (filters: ConsumableFilters) =>
    [...consumableKeys.all, "list", filters] as const,
  detail: (id: string) => [...consumableKeys.all, "detail", id] as const,
  movements: (id: string, query: ConsumableMovementQuery) =>
    [...consumableKeys.all, "detail", id, "movements", query] as const,
};

/** List consumables (raw; category joined client-side), optionally only low-stock items. */
export function useConsumables(filters: ConsumableFilters = {}) {
  return useQuery({
    queryKey: consumableKeys.list(filters),
    queryFn: () => getConsumables(filters),
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
