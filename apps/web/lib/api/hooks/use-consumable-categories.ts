import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateConsumableCategory,
  UpdateConsumableCategory,
} from "@lazyit/shared";
import {
  createConsumableCategory,
  deleteConsumableCategory,
  getConsumableCategories,
  updateConsumableCategory,
} from "../endpoints/consumable-categories";

/** Query keys for Consumable categories. */
export const consumableCategoryKeys = {
  all: ["consumable-categories"] as const,
  lists: () => [...consumableCategoryKeys.all, "list"] as const,
};

/** List all consumable categories (Consumables filter + form select + Settings → Taxonomies table). */
export function useConsumableCategories() {
  return useQuery({
    queryKey: consumableCategoryKeys.lists(),
    queryFn: getConsumableCategories,
  });
}

/** Create a consumable category; invalidates the list. */
export function useCreateConsumableCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateConsumableCategory) =>
      createConsumableCategory(data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: consumableCategoryKeys.all }),
  });
}

/** Update a consumable category; invalidates the list. */
export function useUpdateConsumableCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: UpdateConsumableCategory;
    }) => updateConsumableCategory(id, data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: consumableCategoryKeys.all }),
  });
}

/** Soft-delete a consumable category; invalidates the list. */
export function useDeleteConsumableCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteConsumableCategory(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: consumableCategoryKeys.all }),
  });
}
