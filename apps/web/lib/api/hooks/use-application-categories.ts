import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DeleteResolution,
  CreateApplicationCategory,
  UpdateApplicationCategory,
} from "@lazyit/shared";
import {
  createApplicationCategory,
  deleteApplicationCategory,
  getApplicationCategoryDeleteImpact,
  getApplicationCategories,
  updateApplicationCategory,
} from "../endpoints/application-categories";
import { applicationKeys } from "./use-applications";

/** Query keys for Application categories. */
export const applicationCategoryKeys = {
  all: ["application-categories"] as const,
  lists: () => [...applicationCategoryKeys.all, "list"] as const,
};

/** List all application categories (Access filter + form select + Settings → Taxonomies table). */
export function useApplicationCategories() {
  return useQuery({
    queryKey: applicationCategoryKeys.lists(),
    queryFn: getApplicationCategories,
  });
}

/** Create an application category; invalidates the list. */
export function useCreateApplicationCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateApplicationCategory) =>
      createApplicationCategory(data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: applicationCategoryKeys.all }),
  });
}

/** Update an application category; invalidates the list. */
export function useUpdateApplicationCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: UpdateApplicationCategory;
    }) => updateApplicationCategory(id, data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: applicationCategoryKeys.all }),
  });
}

/** Soft-delete an application category; invalidates the list. */
export function useDeleteApplicationCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, resolution }: { id: string; resolution?: DeleteResolution }) =>
      deleteApplicationCategory(id, resolution),
    onSuccess: (_category, { resolution }) => {
      queryClient.invalidateQueries({ queryKey: applicationCategoryKeys.all });
      if (resolution) queryClient.invalidateQueries({ queryKey: applicationKeys.all });
    },
  });
}

export function useApplicationCategoryDeleteImpact(id: string | undefined) {
  return useQuery({
    queryKey: [...applicationCategoryKeys.all, "delete-impact", id ?? ""],
    queryFn: () => getApplicationCategoryDeleteImpact(id as string),
    enabled: Boolean(id),
    staleTime: 0,
  });
}
