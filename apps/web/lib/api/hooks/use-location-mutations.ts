import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateLocation,
  DeleteResolution,
  UpdateLocation,
} from "@lazyit/shared";
import {
  createLocation,
  deleteLocation,
  getLocationDeleteImpact,
  restoreLocation,
  updateLocation,
} from "../endpoints/locations";
import { assetKeys } from "./use-assets";
import { locationKeys } from "./use-locations";
import { purchaseOrderKeys } from "./use-purchase-orders";

/**
 * Write hooks for the Location resource. Each invalidates the locations list on
 * success so the table refetches. Toasts and dialog state are owned by the
 * calling component, not here — these stay focused on the cache.
 */

export function useCreateLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateLocation) => createLocation(data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: locationKeys.all }),
  });
}

export function useUpdateLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateLocation }) =>
      updateLocation(id, data),
    onSuccess: (_location, { id }) => {
      queryClient.invalidateQueries({ queryKey: locationKeys.all });
      queryClient.invalidateQueries({ queryKey: locationKeys.detail(id) });
    },
  });
}

export function useLocationDeleteImpact(id: string | undefined) {
  return useQuery({
    queryKey: [...locationKeys.detail(id ?? ""), "delete-impact"],
    queryFn: () => getLocationDeleteImpact(id as string),
    enabled: Boolean(id),
    staleTime: 0,
  });
}

export function useDeleteLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, resolution }: { id: string; resolution?: DeleteResolution }) =>
      deleteLocation(id, resolution),
    onSuccess: (_location, { resolution }) => {
      queryClient.invalidateQueries({ queryKey: locationKeys.all });
      // A resolution re-pointed assets and open purchases too.
      if (resolution) {
        queryClient.invalidateQueries({ queryKey: assetKeys.all });
        queryClient.invalidateQueries({ queryKey: purchaseOrderKeys.all });
      }
    },
  });
}

/** Restore one soft-deleted location (ADMIN). Invalidates so the archived list updates. */
export function useRestoreLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreLocation(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: locationKeys.all }),
  });
}
