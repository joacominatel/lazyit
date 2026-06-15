import type {
  ChangeKeypairPassword,
  CreateUserKeypair,
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
 * Change OR reset the caller's PASSWORD wrap (Copy A) of an EXISTING keypair (ADR-0066,
 * `POST /secret-manager/keypair/password`). `data` is the {@link ChangeKeypairPassword} wire DTO produced
 * CLIENT-SIDE by `rewrapPasswordCopy` — the four Copy-A fields only (the new wrapped private-key blob + its
 * fresh salt/IV/KDF params). ONE endpoint serves both **change** (the private key was unlocked with the
 * current password) and **reset** (unlocked with the recovery key); the server cannot tell which and only
 * overwrites Copy A — the public key and the recovery wrap (Copy B) are untouched. 404 if the caller has no
 * keypair (this is NOT bootstrap). Self-only: there is no `:userId` variant. INV-10: the server never sees
 * the private key, either password, or the recovery key — only the wrapped blob.
 */
export function changePassword(
  data: ChangeKeypairPassword,
): Promise<UserKeypair> {
  return apiFetch<UserKeypair>(`${BASE}/keypair/password`, {
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
