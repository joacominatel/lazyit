import { useQuery } from "@tanstack/react-query";
import { getHandleSuggestions, getItemByHandle } from "../endpoints/chip";
import { chipKeys } from "../query-keys";
import { skip4xxRetry } from "./retry";

/**
 * Read hooks for the KB masked-chip touchpoint (ADR-0061 §8, crypto-design §7). Autocomplete lists
 * HANDLES (server-visible metadata) but never values; resolving a handle returns the item ciphertext
 * envelope + the caller's membership so the browser can decrypt in place. No plaintext is ever fetched,
 * cached, or logged — slice 4 (the render plugin) runs the §6 read chain on the returned blobs locally.
 */

/**
 * Handle suggestions for an optional substring `q` (handle/label match), member-scoped. `q` is public
 * metadata — safe in the key. Returns the suggestion list (no values).
 */
export function useHandleSuggestions(q?: string) {
  return useQuery({
    queryKey: chipKeys.handles(q),
    queryFn: () => getHandleSuggestions(q),
    // A 403 means the caller lost membership between navigations. Settle immediately on any 4xx
    // rather than burning 4 round-trips through exponential backoff (fix #444).
    retry: skip4xxRetry,
  });
}

/**
 * Resolve a chip `handle` to the item envelope + the caller's wrapped-DEK membership. `enabled` guards
 * the empty case so resolution runs only when a handle is present. The returned blobs are ciphertext +
 * public material; the browser decrypts locally.
 *
 * A 403 (non-member) or 404 (broken handle / no vault) is a TERMINAL render-gating state for the chip.
 * `retry` skips 4xx immediately; `retryOnMount: false` prevents a settled-error from re-firing when a
 * new chip component mounts; `refetchOnWindowFocus: false` prevents the same for window refocus — both
 * mirror the keypair fix (#442) and stop the loading-skeleton loop on N chips per article.
 */
export function useResolvedHandle(handle: string | undefined) {
  return useQuery({
    queryKey: chipKeys.byHandle(handle ?? ""),
    queryFn: () => getItemByHandle(handle as string),
    enabled: Boolean(handle),
    retry: skip4xxRetry,
    retryOnMount: false,
    refetchOnWindowFocus: false,
  });
}
