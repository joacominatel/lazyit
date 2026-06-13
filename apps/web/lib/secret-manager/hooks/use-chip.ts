import { useQuery } from "@tanstack/react-query";
import { getHandleSuggestions, getItemByHandle } from "../endpoints/chip";
import { chipKeys } from "../query-keys";

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
  });
}

/**
 * Resolve a chip `handle` to the item envelope + the caller's wrapped-DEK membership. `enabled` guards
 * the empty case so resolution runs only when a handle is present. The returned blobs are ciphertext +
 * public material; the browser decrypts locally.
 */
export function useResolvedHandle(handle: string | undefined) {
  return useQuery({
    queryKey: chipKeys.byHandle(handle ?? ""),
    queryFn: () => getItemByHandle(handle as string),
    enabled: Boolean(handle),
  });
}
