import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Consumable, CreateConsumableMovement } from "@lazyit/shared";
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

/** The signed delta a quick-adjust applies to `currentStock` (+1 IN, -1 OUT). */
type QuickAdjustDelta = 1 | -1;

interface QuickAdjustVars {
  consumableId: string;
  /** +1 records a quantity-1 IN movement; -1 records a quantity-1 OUT movement. */
  delta: QuickAdjustDelta;
}

/** Bump every cached `currentStock` for `consumableId` by `delta` (detail + every list query). */
function patchCachedStock(
  queryClient: ReturnType<typeof useQueryClient>,
  consumableId: string,
  delta: number,
): void {
  // Detail caches (keyed by id) — there's at most one, but match defensively.
  queryClient.setQueriesData<Consumable>(
    { queryKey: consumableKeys.detail(consumableId) },
    (current) =>
      current
        ? { ...current, currentStock: current.currentStock + delta }
        : current,
  );
  // Every list query (filters vary, so patch them all).
  queryClient.setQueriesData<Consumable[]>(
    { queryKey: consumableKeys.lists() },
    (current) =>
      current?.map((consumable) =>
        consumable.id === consumableId
          ? { ...consumable, currentStock: consumable.currentStock + delta }
          : consumable,
      ),
  );
}

/**
 * One-click stock quick-adjust: record a minimal quantity-1 IN (+1) or OUT (-1) movement with an
 * optimistic `currentStock` bump across the list and detail caches, rolling back on error. The OUT
 * is still guarded by the API (409 if it would go negative) — callers surface that as a toast. No
 * `reason`/`notes` are sent: this is the fast path; the detailed dialog stays available for those.
 */
export function useQuickAdjustStock() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ consumableId, delta }: QuickAdjustVars) =>
      createConsumableMovement(consumableId, {
        type: delta > 0 ? "IN" : "OUT",
        quantity: 1,
      }),
    onMutate: async ({ consumableId, delta }) => {
      // Cancel in-flight reads so they can't clobber the optimistic patch on resolve.
      await queryClient.cancelQueries({ queryKey: consumableKeys.all });
      const previousDetail = queryClient.getQueryData<Consumable>(
        consumableKeys.detail(consumableId),
      );
      const previousLists = queryClient.getQueriesData<Consumable[]>({
        queryKey: consumableKeys.lists(),
      });
      patchCachedStock(queryClient, consumableId, delta);
      return { previousDetail, previousLists, consumableId };
    },
    onError: (_error, { consumableId }, context) => {
      // Roll back to the pre-mutation snapshot.
      if (context?.previousDetail !== undefined) {
        queryClient.setQueryData(
          consumableKeys.detail(consumableId),
          context.previousDetail,
        );
      }
      for (const [key, data] of context?.previousLists ?? []) {
        queryClient.setQueryData(key, data);
      }
    },
    // Reconcile with the server (also refetches the movement ledger).
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: consumableKeys.all }),
  });
}
