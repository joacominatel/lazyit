import type { CreateSupplier, UpdateSupplier } from "@lazyit/shared";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  createSupplier,
  deleteSupplier,
  getSupplier,
  getSupplierMergePreview,
  getSuppliers,
  mergeSupplier,
  restoreSupplier,
  type SupplierListParams,
  updateSupplier,
} from "../endpoints/suppliers";
import { purchaseOrderKeys } from "./use-purchase-orders";
import { invalidateSuggestions } from "../query-keys";

/** Query keys for Suppliers. */
export const supplierKeys = {
  all: ["suppliers"] as const,
  lists: () => [...supplierKeys.all, "list"] as const,
  list: (params: SupplierListParams) => [...supplierKeys.all, "list", params] as const,
  detail: (id: string) => [...supplierKeys.all, "detail", id] as const,
  mergePreview: (targetId: string, sourceId: string) =>
    [...supplierKeys.all, "merge-preview", targetId, sourceId] as const,
};

/** One page of suppliers (server-side search and paging). */
export function useSuppliers(
  params: SupplierListParams = {},
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: supplierKeys.list(params),
    queryFn: ({ signal }) => getSuppliers(params, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** One supplier; idle until an id is provided. */
export function useSupplier(id: string | undefined) {
  return useQuery({
    queryKey: supplierKeys.detail(id ?? ""),
    queryFn: () => getSupplier(id as string),
    enabled: Boolean(id),
  });
}

/**
 * Every supplier write refreshes suppliers, the purchases that embed the supplier's name, and the
 * smart-entry suggestions (a new name is a new suggestion).
 */
function useInvalidateSuppliers() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: supplierKeys.all });
    void queryClient.invalidateQueries({ queryKey: purchaseOrderKeys.all });
    void invalidateSuggestions(queryClient);
  };
}

export function useCreateSupplier() {
  const invalidate = useInvalidateSuppliers();
  return useMutation({
    mutationFn: (data: CreateSupplier) => createSupplier(data),
    onSuccess: invalidate,
  });
}

export function useUpdateSupplier() {
  const invalidate = useInvalidateSuppliers();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateSupplier }) => updateSupplier(id, data),
    onSuccess: invalidate,
  });
}

export function useDeleteSupplier() {
  const invalidate = useInvalidateSuppliers();
  return useMutation({
    mutationFn: (id: string) => deleteSupplier(id),
    onSuccess: invalidate,
  });
}

export function useRestoreSupplier() {
  const invalidate = useInvalidateSuppliers();
  return useMutation({
    mutationFn: (id: string) => restoreSupplier(id),
    onSuccess: invalidate,
  });
}

/** What merging `sourceId` into `targetId` would do; idle until both are chosen. */
export function useSupplierMergePreview(targetId: string | undefined, sourceId: string | undefined) {
  return useQuery({
    queryKey: supplierKeys.mergePreview(targetId ?? "", sourceId ?? ""),
    queryFn: ({ signal }) => getSupplierMergePreview(targetId as string, sourceId as string, signal),
    enabled: Boolean(targetId && sourceId && targetId !== sourceId),
    // Always re-read on open: the duplicate's purchases may have changed since.
    staleTime: 0,
  });
}

/** Merge a duplicate into the supplier that stays (ADMIN): refreshes suppliers, purchases and suggestions. */
export function useMergeSupplier() {
  const invalidate = useInvalidateSuppliers();
  return useMutation({
    mutationFn: ({ targetId, sourceId }: { targetId: string; sourceId: string }) =>
      mergeSupplier(targetId, sourceId),
    onSuccess: invalidate,
  });
}
