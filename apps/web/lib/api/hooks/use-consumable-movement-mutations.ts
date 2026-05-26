import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateConsumableMovement } from "@lazyit/shared";
import { createConsumableMovement } from "../endpoints/consumables";
import { consumableKeys } from "./use-consumables";

/**
 * Record a stock movement (IN / OUT / ADJUSTMENT). Invalidates `consumableKeys.all` so the cached
 * `currentStock` (on the list and detail) and the movement ledger refetch. A 409 (an OUT that would
 * go negative) rejects — callers surface it as a toast.
 */
export function useRecordMovement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      consumableId,
      data,
    }: {
      consumableId: string;
      data: CreateConsumableMovement;
    }) => createConsumableMovement(consumableId, data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: consumableKeys.all }),
  });
}
