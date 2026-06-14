import type { HandleSuggestion, ResolvedHandle } from "@lazyit/shared";
import { apiFetch } from "../../api/client";

/**
 * Data-access for the KB masked-chip touchpoint (`{{ lazyit_secret.HANDLE }}`, ADR-0061 §8,
 * crypto-design §7). Autocomplete offers HANDLES (server-visible metadata) but NEVER values; resolving a
 * chip returns the referenced item's ciphertext envelope PLUS the caller's own wrapped-DEK membership, so
 * the browser can run the §6 read chain in place. The plaintext value never round-trips through the
 * server (INV-10). Slice 4 (the render plugin) consumes these; the contract is wired here in 3a.
 *
 * Backend contract (slice 2b): `GET /secret-manager/items/handles?q=`,
 * `GET /secret-manager/items/by-handle/:handle`. Both are member-scoped (only the caller's vaults).
 */

const BASE = "/secret-manager/items";

/**
 * List handle suggestions, optionally filtered by a case-insensitive substring `q` over handle/label.
 * Member-scoped, capped server-side. Never carries a value.
 */
export function getHandleSuggestions(
  q?: string,
): Promise<HandleSuggestion[]> {
  const qs = q ? `?${new URLSearchParams({ q }).toString()}` : "";
  return apiFetch<HandleSuggestion[]>(`${BASE}/handles${qs}`);
}

/**
 * Resolve a chip handle to the item envelope + the caller's wrapped-DEK membership. The returned blobs
 * are ciphertext + public material; the browser decrypts locally (never the server).
 */
export function getItemByHandle(handle: string): Promise<ResolvedHandle> {
  return apiFetch<ResolvedHandle>(
    `${BASE}/by-handle/${encodeURIComponent(handle)}`,
  );
}
