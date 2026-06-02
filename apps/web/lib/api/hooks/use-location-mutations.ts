import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateLocation, UpdateLocation } from "@lazyit/shared";
import {
  createLocation,
  deleteLocation,
  restoreLocation,
  updateLocation,
} from "../endpoints/locations";
import { locationKeys } from "./use-locations";

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

export function useDeleteLocation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteLocation(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: locationKeys.all }),
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
