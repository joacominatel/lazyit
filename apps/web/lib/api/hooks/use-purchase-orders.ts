import type {
  ApplyLicense,
  CancelRemainingUnits,
  CreatePurchaseFromAssets,
  CreatePurchaseOrder,
  CreatePurchaseOrderLine,
  LinkAssetsToLine,
  ReceiveFromLine,
  ReceiveStockFromLine,
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
  applyLicense,
  cancelRemainingUnits,
  createPurchaseFromAssets,
  createPurchaseOrder,
  deletePurchaseOrder,
  extractPurchaseDocument,
  getAssetPurchase,
  getExtractionStatus,
  getLicenseProposal,
  getLinkPreview,
  getPendingLines,
  getPurchaseOrder,
  getPurchaseOrderEvents,
  getPurchaseOrders,
  linkAssetsToLine,
  type PurchaseOrderListParams,
  receiveFromLine,
  receiveStockFromLine,
  removePurchaseOrderLine,
  restorePurchaseOrder,
  unlinkAssetsFromLine,
  updatePurchaseOrder,
  updatePurchaseOrderLine,
} from "../endpoints/purchase-orders";
import { applicationKeys } from "./use-applications";
import { assetHistoryKeys } from "./use-asset-history";
import { useInvalidateAssets } from "./use-assets";
import { consumableKeys } from "./use-consumables";
import { invalidateDashboard } from "./use-dashboard";
import { invalidateSuggestions } from "../query-keys";

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
  pending: (params: { supplierId?: string; limit?: number; offset?: number }) =>
    [...purchaseOrderKeys.all, "pending", params] as const,
  /** Every open line, read to the end (the *From purchase* picker). */
  openLines: () => [...purchaseOrderKeys.all, "pending", "all"] as const,
  linkPreview: (lineId: string, assetIds: readonly string[]) =>
    [...purchaseOrderKeys.all, "link-preview", lineId, assetIds] as const,
  /** An asset's provenance lives under the purchase keys, so any purchase write refreshes it. */
  provenance: (assetId: string) => [...purchaseOrderKeys.all, "provenance", assetId] as const,
  /** Whether document extraction can be offered to this caller (#1477). */
  extractionStatus: () => [...purchaseOrderKeys.all, "extraction-status"] as const,
  licenseProposal: (lineId: string) => [...purchaseOrderKeys.all, "license-proposal", lineId] as const,
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

// ── Flows (#1473) ─────────────────────────────────────────────────────────────────────────────────────

/** Lines still waiting for units, oldest purchase first. Idle unless `enabled` (callers gate on permission). */
export function usePendingLines(
  params: { supplierId?: string; limit?: number; offset?: number } = {},
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: purchaseOrderKeys.pending(params),
    queryFn: ({ signal }) => getPendingLines(params, signal),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** The link diff for these assets against one line; idle until there is a line and at least one asset. */
export function useLinkPreview(
  target: { purchaseOrderId: string; lineId: string } | null,
  assetIds: readonly string[],
) {
  return useQuery({
    queryKey: purchaseOrderKeys.linkPreview(target?.lineId ?? "", assetIds),
    queryFn: ({ signal }) =>
      getLinkPreview(target!.purchaseOrderId, target!.lineId, [...assetIds], signal),
    enabled: target !== null && assetIds.length > 0,
  });
}

/**
 * An asset's purchase provenance (ADR-0099 D-A). The caller passes `enabled` only when the viewer holds
 * `purchaseOrder:read` and the asset is linked — without the permission no request is ever made.
 */
export function useAssetPurchase(assetId: string, { enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: purchaseOrderKeys.provenance(assetId),
    queryFn: ({ signal }) => getAssetPurchase(assetId, signal),
    enabled,
  });
}

/**
 * Receiving and linking change both sides: the purchase (counts, log) and the assets (new units, values,
 * history). One invalidation for every flow write.
 */
function useInvalidateFlows() {
  const queryClient = useQueryClient();
  const invalidatePurchases = useInvalidatePurchases();
  const invalidateAssets = useInvalidateAssets();
  return () => {
    invalidatePurchases();
    invalidateAssets();
    void queryClient.invalidateQueries({ queryKey: assetHistoryKeys.all });
  };
}

export function useReceiveFromLine() {
  const invalidate = useInvalidateFlows();
  return useMutation({
    mutationFn: ({ id, lineId, data }: { id: string; lineId: string; data: ReceiveFromLine }) =>
      receiveFromLine(id, lineId, data),
    onSuccess: invalidate,
  });
}

/**
 * Receive a consumable line into stock (#1476): the purchase (counts, log) and the consumable (stock, its
 * movement ledger, the dashboard's low-stock tally) both change.
 */
export function useReceiveStock() {
  const queryClient = useQueryClient();
  const invalidatePurchases = useInvalidatePurchases();
  return useMutation({
    mutationFn: ({ id, lineId, data }: { id: string; lineId: string; data: ReceiveStockFromLine }) =>
      receiveStockFromLine(id, lineId, data),
    onSuccess: () => {
      invalidatePurchases();
      void queryClient.invalidateQueries({ queryKey: consumableKeys.all });
      void invalidateDashboard(queryClient);
    },
  });
}

export function useLinkAssets() {
  const invalidate = useInvalidateFlows();
  return useMutation({
    mutationFn: ({ id, lineId, data }: { id: string; lineId: string; data: LinkAssetsToLine }) =>
      linkAssetsToLine(id, lineId, data),
    onSuccess: invalidate,
  });
}

export function useUnlinkAssets() {
  const invalidate = useInvalidateFlows();
  return useMutation({
    mutationFn: ({ id, lineId, assetIds }: { id: string; lineId: string; assetIds: string[] }) =>
      unlinkAssetsFromLine(id, lineId, assetIds),
    onSuccess: invalidate,
  });
}

export function useCancelRemainingUnits() {
  const invalidate = useInvalidatePurchases();
  return useMutation({
    mutationFn: ({ id, lineId, data }: { id: string; lineId: string; data: CancelRemainingUnits }) =>
      cancelRemainingUnits(id, lineId, data),
    onSuccess: invalidate,
  });
}

// ── Phase 2 (#1477) ───────────────────────────────────────────────────────────────────────────────────

/**
 * Whether *Read this document* can be offered, and for which types. Idle unless `enabled` (callers ask only
 * when the viewer can write purchases). Not a fast-moving fact: an admin flips the switch rarely.
 */
export function useExtractionStatus({ enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: purchaseOrderKeys.extractionStatus(),
    queryFn: ({ signal }) => getExtractionStatus(signal),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Read a document into a draft (#1477). Explicit only — a mutation, never a query, because each run sends the
 * document out and spends the caller's AI budget. Success or failure, the purchase gains an `EXTRACTION_RUN`
 * event, so its log is refreshed either way; nothing else changed.
 */
export function useExtractPurchaseDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, attachmentId }: { id: string; attachmentId: string }) =>
      extractPurchaseDocument(id, attachmentId),
    onSettled: (_data, _error, { id }) => {
      void queryClient.invalidateQueries({ queryKey: purchaseOrderKeys.events(id) });
    },
  });
}

/** What applying a license line would do; idle until a line is given. */
export function useLicenseProposal(target: { purchaseOrderId: string; lineId: string } | null) {
  return useQuery({
    queryKey: purchaseOrderKeys.licenseProposal(target?.lineId ?? ""),
    queryFn: ({ signal }) => getLicenseProposal(target!.purchaseOrderId, target!.lineId, signal),
    enabled: target !== null,
  });
}

/** Apply a license line: the purchase (applied seats, log) and the application (seats, renewal) both change. */
export function useApplyLicense() {
  const queryClient = useQueryClient();
  const invalidatePurchases = useInvalidatePurchases();
  return useMutation({
    mutationFn: ({ id, lineId, data }: { id: string; lineId: string; data: ApplyLicense }) =>
      applyLicense(id, lineId, data),
    onSuccess: () => {
      invalidatePurchases();
      void queryClient.invalidateQueries({ queryKey: applicationKeys.all });
    },
  });
}

/** Create a purchase from selected assets: a new purchase, and the assets' links and history. */
export function useCreatePurchaseFromAssets() {
  const invalidate = useInvalidateFlows();
  return useMutation({
    mutationFn: (data: CreatePurchaseFromAssets) => createPurchaseFromAssets(data),
    onSuccess: invalidate,
  });
}
