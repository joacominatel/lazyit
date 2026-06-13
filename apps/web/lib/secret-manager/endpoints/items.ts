import type {
  CreateSecretItem,
  SecretItem,
  UpdateSecretItem,
} from "@lazyit/shared";
import { apiFetch } from "../../api/client";

/**
 * Data-access for `SecretItem` — a single secret VALUE inside a vault (ADR-0061 §2, crypto-design §3).
 * The row stores ONLY the ciphertext envelope (`ciphertext`/`iv`/`authTag`/`keyVersion`, base64) of the
 * value, encrypted client-side under the vault DEK (`sealItem`). UNLIKE `WorkflowSecret`, the read shape
 * CARRIES the envelope blobs — they are ciphertext, safe to hand the member's browser, which alone holds
 * the unwrapped DEK. The server can NEVER produce the plaintext value (INV-10).
 *
 * Backend contract (slice 2b): `GET /secret-vaults/:id/items`, `POST /secret-vaults/:id/items`,
 * `PATCH /secret-vaults/:id/items/:itemId`, `DELETE /secret-vaults/:id/items/:itemId`.
 */

const BASE = "/secret-vaults";

/** List a vault's items (with their at-rest envelope blobs — ciphertext, never plaintext). */
export function getItems(vaultId: string): Promise<SecretItem[]> {
  return apiFetch<SecretItem[]>(`${BASE}/${vaultId}/items`);
}

/**
 * Create an item. `data` carries the server-visible `handle`/`label` plus the already-encrypted envelope
 * produced client-side (`sealItem(dek, value)` → `{ ciphertext, iv, authTag, keyVersion }`). The
 * plaintext value is structurally absent from `data`.
 */
export function createItem(
  vaultId: string,
  data: CreateSecretItem,
): Promise<SecretItem> {
  return apiFetch<SecretItem>(`${BASE}/${vaultId}/items`, {
    method: "POST",
    body: data,
  });
}

/**
 * Update an item: a metadata edit (`handle`/`label`) and/or a value change (a fresh envelope re-encrypted
 * under the same DEK). When the value changes, all four envelope fields must be sent together. No
 * plaintext ever appears in `data`.
 */
export function updateItem(
  vaultId: string,
  itemId: string,
  data: UpdateSecretItem,
): Promise<SecretItem> {
  return apiFetch<SecretItem>(`${BASE}/${vaultId}/items/${itemId}`, {
    method: "PATCH",
    body: data,
  });
}

/** Soft-delete an item. Returns the soft-deleted item (`deletedAt` set). */
export function deleteItem(
  vaultId: string,
  itemId: string,
): Promise<SecretItem> {
  return apiFetch<SecretItem>(`${BASE}/${vaultId}/items/${itemId}`, {
    method: "DELETE",
  });
}
