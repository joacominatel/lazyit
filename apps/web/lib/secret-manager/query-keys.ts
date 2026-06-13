/**
 * TanStack Query key factory for the Secret Manager (ADR-0061, slice 3a). Built on the shared
 * `createQueryKeys` helper (ADR-0020) so read hooks and the mutations that invalidate them can't drift.
 *
 * HARD INV-10 RULE FOR KEYS: a query key is a CACHE INDEX, not a payload — it may contain ONLY non-secret
 * identifiers (vault id, item id, the public `userId`, a handle substring). It MUST NEVER contain a
 * passphrase, a recovery key, a private key, a DEK, or a plaintext value. (No secret is keyed here; this
 * comment is the guard for future edits.)
 */

import { createQueryKeys } from "../api/query-keys";

/** The caller's own keypair + other users' public keys (the wrap target lookup). */
const keypairBase = createQueryKeys("secret-keypair");
export const keypairKeys = {
  ...keypairBase,
  /** The caller's own keypair. */
  me: () => [...keypairBase.all, "me"] as const,
  /** Another user's public key (the grant-wrap target). `userId` is a public identifier, never secret. */
  publicKey: (userId: string) =>
    [...keypairBase.all, "public-key", userId] as const,
};

/** Vaults — the list and per-vault detail (with embedded members). */
const vaultBase = createQueryKeys("secret-vaults");
export const vaultKeys = {
  ...vaultBase,
  /** All vaults visible to the caller. */
  list: () => vaultBase.lists(),
  /** One vault's detail (metadata + embedded members). */
  detail: (vaultId: string) => vaultBase.detail(vaultId),
};

/** Items within a vault (their at-rest ciphertext envelopes — never plaintext). */
const itemBase = createQueryKeys("secret-items");
export const itemKeys = {
  ...itemBase,
  /** All items in a vault, scoped by `vaultId`. */
  list: (vaultId: string) => [...itemBase.all, "list", vaultId] as const,
};

/** Membership — a vault's member metadata list and the caller's own wrapped-DEK membership. */
const membershipBase = createQueryKeys("secret-memberships");
export const membershipKeys = {
  ...membershipBase,
  /** A vault's member metadata list. */
  members: (vaultId: string) =>
    [...membershipBase.all, "members", vaultId] as const,
  /** The caller's OWN membership (wrapped-DEK row) for a vault. */
  me: (vaultId: string) => [...membershipBase.all, "me", vaultId] as const,
};

/** Chip — handle autocomplete and by-handle resolution. The `q`/`handle` keys are public metadata. */
const chipBase = createQueryKeys("secret-chip");
export const chipKeys = {
  ...chipBase,
  /** Handle suggestions for an (optional) substring `q`. */
  handles: (q: string | undefined) =>
    [...chipBase.all, "handles", { q: q ?? null }] as const,
  /** A resolved handle (item envelope + the caller's membership). `handle` is public metadata. */
  byHandle: (handle: string) =>
    [...chipBase.all, "by-handle", handle] as const,
};
