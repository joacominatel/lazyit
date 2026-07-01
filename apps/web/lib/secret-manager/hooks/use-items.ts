import type { CreateSecretItem, UpdateSecretItem } from "@lazyit/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createItem,
  deleteItem,
  getItems,
  recordReveal,
  updateItem,
} from "../endpoints/items";
import { itemKeys } from "../query-keys";
import { skip4xxRetry } from "./retry";

/**
 * Read + write hooks for `SecretItem` (ADR-0061 §2, crypto-design §3). Lists carry the at-rest ciphertext
 * envelope; the create/update bodies carry the client-sealed envelope (`sealItem(dek, value)`). The
 * PLAINTEXT value is never passed to these hooks, never cached, never logged — only the ciphertext blobs
 * cross this boundary (INV-10).
 */

/** List a vault's items (ciphertext envelopes — the browser decrypts with the unwrapped DEK). */
export function useItems(vaultId: string | undefined) {
  return useQuery({
    queryKey: itemKeys.list(vaultId ?? ""),
    queryFn: () => getItems(vaultId as string),
    enabled: Boolean(vaultId),
    // A 403 (non-member) is terminal — the vault isn't unlocked, so the list is inaccessible.
    // Skip 4xx immediately rather than burning 4 GET retries with backoff (fix #444).
    retry: skip4xxRetry,
  });
}

/** Create an item from an already-sealed envelope + metadata. Invalidates the vault's item list. */
export function useCreateItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      vaultId,
      data,
    }: {
      vaultId: string;
      data: CreateSecretItem;
    }) => createItem(vaultId, data),
    onSuccess: (_result, { vaultId }) =>
      queryClient.invalidateQueries({ queryKey: itemKeys.list(vaultId) }),
  });
}

/** Update an item (metadata and/or a re-sealed envelope). Invalidates the vault's item list. */
export function useUpdateItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      vaultId,
      itemId,
      data,
    }: {
      vaultId: string;
      itemId: string;
      data: UpdateSecretItem;
    }) => updateItem(vaultId, itemId, data),
    onSuccess: (_result, { vaultId }) =>
      queryClient.invalidateQueries({ queryKey: itemKeys.list(vaultId) }),
  });
}

/**
 * Record a single-item REVEAL (#870) — the metadata-only audit call AFTER the browser has decrypted the
 * item's value. No cache invalidation (it mutates only the server-side audit log, nothing the UI reads).
 * Called fire-and-forget from the reveal surfaces (`.mutate`, best-effort) so a failed or blocked audit
 * write never stops a member from seeing their own secret. INV-10: the call carries no secret material.
 */
export function useRecordReveal() {
  return useMutation({
    mutationFn: ({ vaultId, itemId }: { vaultId: string; itemId: string }) =>
      recordReveal(vaultId, itemId),
  });
}

/** Soft-delete an item. Invalidates the vault's item list. */
export function useDeleteItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ vaultId, itemId }: { vaultId: string; itemId: string }) =>
      deleteItem(vaultId, itemId),
    onSuccess: (_result, { vaultId }) =>
      queryClient.invalidateQueries({ queryKey: itemKeys.list(vaultId) }),
  });
}
