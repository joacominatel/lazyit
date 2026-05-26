import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateConsumable, UpdateConsumable } from "@lazyit/shared";
import {
  createConsumable,
  deleteConsumable,
  updateConsumable,
} from "../endpoints/consumables";
import { consumableKeys } from "./use-consumables";

/** Consumable writes — each invalidates `consumableKeys.all` so the list and detail refetch. */
function useInvalidateConsumables() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: consumableKeys.all });
}

export function useCreateConsumable() {
  const invalidate = useInvalidateConsumables();
  return useMutation({
    mutationFn: (data: CreateConsumable) => createConsumable(data),
    onSuccess: invalidate,
  });
}

export function useUpdateConsumable() {
  const invalidate = useInvalidateConsumables();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateConsumable }) =>
      updateConsumable(id, data),
    onSuccess: invalidate,
  });
}

export function useDeleteConsumable() {
  const invalidate = useInvalidateConsumables();
  return useMutation({
    mutationFn: (id: string) => deleteConsumable(id),
    onSuccess: invalidate,
  });
}
