import { useMutation } from "@tanstack/react-query";
import type { ReceiveAssets } from "@lazyit/shared";
import { receiveAssets } from "../endpoints/asset-receive";
import { useInvalidateAssets } from "./use-assets";

/**
 * Bulk-receive hook (ADR-0089 Part A, #1029). On success it invalidates the shared asset cache (list,
 * detail, dashboard status counts) via {@link useInvalidateAssets} — a receive mints new assets that
 * must appear in the inventory list and shift the summary. The mutation resolves with the
 * `{ created, failed }` envelope so the caller can render the partial-success result (it never throws
 * on a partial failure — the API returns 201 even when every unit fails; only a transport/validation
 * error rejects). Toasts and dialog state are owned by the calling component.
 */
export function useReceiveAssets() {
  const invalidate = useInvalidateAssets();
  return useMutation({
    mutationFn: (data: ReceiveAssets) => receiveAssets(data),
    onSuccess: invalidate,
  });
}
