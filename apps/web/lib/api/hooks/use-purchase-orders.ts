import type {
  CreatePurchaseOrder,
  CreatePurchaseOrderLine,
  UpdatePurchaseOrder,
  UpdatePurchaseOrderLine,
} from "@lazyit/shared";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  addPurchaseOrderLine,
  createPurchaseOrder,
  deletePurchaseOrder,
  getPurchaseOrder,
  getPurchaseOrderEvents,
  getPurchaseOrders,
  type PurchaseOrderListParams,
  removePurchaseOrderLine,
  restorePurchaseOrder,
  updatePurchaseOrder,
  updatePurchaseOrderLine,
} from "../endpoints/purchase-orders";
import { invalidateSuggestions } from "./use-suggestions";

/** Activity-log page size. */
const EVENTS_PAGE_SIZE = 50;

/**
 * Query keys for Purchases. The activity log nests under its purchase's detail, so a write (which
 * invalidates `all`) refreshes the list, the detail and the log together.
 */
export const purchaseOrderKeys = {
  all: ["purchase-orders"] as const,
  lists: () => [...purchaseOrderKeys.all, "list"] as const,
  list: (params: PurchaseOrderListParams) => [...purchaseOrderKeys.all, "list", params] as const,
  detail: (id: string) => [...purchaseOrderKeys.all, "detail", id] as const,
  events: (id: string) => [...purchaseOrderKeys.all, "detail", id, "events"] as const,
};

/** One page of purchases (server-side search, filters and paging). */
export function usePurchaseOrders(
  params: PurchaseOrderListParams = {},
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: purchaseOrderKeys.list(params),
    queryFn: ({ signal }) => getPurchaseOrders(params, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** One purchase with its lines and derived values; idle until an id is provided. */
export function usePurchaseOrder(id: string | undefined) {
  return useQuery({
    queryKey: purchaseOrderKeys.detail(id ?? ""),
    queryFn: () => getPurchaseOrder(id as string),
    enabled: Boolean(id),
  });
}

/** A purchase's activity log, newest first, loaded a page at a time. */
export function usePurchaseOrderEvents(id: string | undefined) {
  return useInfiniteQuery({
    queryKey: purchaseOrderKeys.events(id ?? ""),
    queryFn: ({ pageParam }) =>
      getPurchaseOrderEvents(id as string, { limit: EVENTS_PAGE_SIZE, offset: pageParam }),
    enabled: Boolean(id),
    initialPageParam: 0,
    getNextPageParam: (last) =>
      last.offset + last.items.length < last.total ? last.offset + last.items.length : undefined,
  });
}

/** Every purchase write refreshes the purchase reads and the smart-entry suggestions. */
function useInvalidatePurchases() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: purchaseOrderKeys.all });
    void invalidateSuggestions(queryClient);
  };
}

export function useCreatePurchaseOrder() {
  const invalidate = useInvalidatePurchases();
  return useMutation({
    mutationFn: (data: CreatePurchaseOrder) => createPurchaseOrder(data),
    onSuccess: invalidate,
  });
}

export function useUpdatePurchaseOrder() {
  const invalidate = useInvalidatePurchases();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdatePurchaseOrder }) =>
      updatePurchaseOrder(id, data),
    onSuccess: invalidate,
  });
}

export function useDeletePurchaseOrder() {
  const invalidate = useInvalidatePurchases();
  return useMutation({
    mutationFn: (id: string) => deletePurchaseOrder(id),
    onSuccess: invalidate,
  });
}

export function useRestorePurchaseOrder() {
  const invalidate = useInvalidatePurchases();
  return useMutation({
    mutationFn: (id: string) => restorePurchaseOrder(id),
    onSuccess: invalidate,
  });
}

export function useAddPurchaseOrderLine() {
  const invalidate = useInvalidatePurchases();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: CreatePurchaseOrderLine }) =>
      addPurchaseOrderLine(id, data),
    onSuccess: invalidate,
  });
}

export function useUpdatePurchaseOrderLine() {
  const invalidate = useInvalidatePurchases();
  return useMutation({
    mutationFn: ({
      id,
      lineId,
      data,
    }: {
      id: string;
      lineId: string;
      data: UpdatePurchaseOrderLine;
    }) => updatePurchaseOrderLine(id, lineId, data),
    onSuccess: invalidate,
  });
}

export function useRemovePurchaseOrderLine() {
  const invalidate = useInvalidatePurchases();
  return useMutation({
    mutationFn: ({ id, lineId }: { id: string; lineId: string }) =>
      removePurchaseOrderLine(id, lineId),
    onSuccess: invalidate,
  });
}
