import type {
  CreateUserKeypair,
  RegenerateRecoveryKey,
  UserKeypair,
  UserPublicKey,
} from "@lazyit/shared";
import { apiFetch } from "../../api/client";

/**
 * Data-access for the per-user `UserKeypair` — the Secret Manager identity vault DEKs are wrapped TO
 * (ADR-0061 §3, crypto-design §2/§4). The CLIENT mints the keypair, double-wraps the private key
 * (passphrase + recovery key) in the browser, and posts ONLY public material + the wrapped blobs (see
 * `lib/secret-manager/crypto.ts#bootstrapKeypair`). The server is a ciphertext custodian: it NEVER sees
 * the private key, the passphrase, or the recovery key (INV-10).
 *
 * Backend contract (slice 2b, no global route prefix): `GET /secret-manager/keypair/me`,
 * `POST /secret-manager/keypair`, `PUT /secret-manager/keypair/me`,
 * `POST /secret-manager/keypair/recovery` (ADR-0065 — regenerate the recovery wrap only),
 * `GET /secret-manager/users/:userId/public-key`.
 */

const BASE = "/secret-manager";

/** Fetch the caller's own keypair (public key + both wrapped private-key copies + salts/IVs). */
export function getMyKeypair(): Promise<UserKeypair> {
  return apiFetch<UserKeypair>(`${BASE}/keypair/me`);
}

/**
 * Create the caller's keypair. `data` is the {@link CreateUserKeypair} wire DTO produced CLIENT-SIDE by
 * `bootstrapKeypair` — base64 blobs + metadata only. The private key, passphrase, and recovery key are
 * structurally absent from `data`.
 */
export function createKeypair(data: CreateUserKeypair): Promise<UserKeypair> {
  return apiFetch<UserKeypair>(`${BASE}/keypair`, { method: "POST", body: data });
}

/**
 * Reset / replace the caller's keypair on peer-reset or passphrase change. Same wire DTO as create — a
 * freshly-minted keypair (new public key, re-wrapped private key, new recovery key); surviving vault
 * members then re-wrap each DEK to the new public key (a separate membership re-wrap).
 */
export function resetMyKeypair(data: CreateUserKeypair): Promise<UserKeypair> {
  return apiFetch<UserKeypair>(`${BASE}/keypair/me`, { method: "PUT", body: data });
}

/**
 * Regenerate ONLY the recovery wrap of the caller's EXISTING keypair (ADR-0065). `data` is the
 * {@link RegenerateRecoveryKey} wire DTO produced CLIENT-SIDE by `regenerateRecoveryWrap` — the three
 * recovery-wrap columns ONLY (the new recovery-key-wrapped private-key blob + its salt + IV). The server
 * overwrites exactly those three columns on the live keypair and returns the FULL updated `UserKeypair`
 * (same shape as `GET /keypair/me`); the public key, the passphrase wrap, `kdfParams`, the per-vault DEKs,
 * and every membership are untouched. 404 if the caller has no keypair (this is NOT bootstrap — it requires
 * a live keypair). The server never sees the private key, the passphrase, or the recovery key (INV-10).
 */
export function regenerateRecoveryKey(
  data: RegenerateRecoveryKey,
): Promise<UserKeypair> {
  return apiFetch<UserKeypair>(`${BASE}/keypair/recovery`, {
    method: "POST",
    body: data,
  });
}

/**
 * Fetch another user's public key (the wrap target when granting them a vault). Returns `{ userId,
 * publicKey }` — public material only, never private blobs.
 */
export function getUserPublicKey(userId: string): Promise<UserPublicKey> {
  return apiFetch<UserPublicKey>(`${BASE}/users/${userId}/public-key`);
}
