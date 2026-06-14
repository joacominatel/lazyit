"use client";

import { useCallback } from "react";
import { unwrapDekFromMembership } from "@/lib/secret-manager/crypto";
import { useMyMembership } from "@/lib/secret-manager/hooks/use-members";
import { useSecretDek, useSecretSession } from "./secret-session";

/**
 * useVaultDek — the read-chain bridge (ADR-0061 / crypto-design §6 step 2), packaged for the UI.
 *
 * This is the single place that turns "my private key is unlocked" into "I hold THIS vault's DEK in
 * memory". It composes:
 *   1. the in-memory session (the unlocked X25519 private key + the per-vault DEK cache), and
 *   2. {@link useMyMembership} (the caller's own wrapped-DEK blob for this vault).
 *
 * `ensureDek()` returns the cached DEK if this vault was already unwrapped this session; otherwise it
 * unwraps it from the caller's membership using the unlocked private key, CACHES it (so subsequent
 * reveals are instant), and returns it. It returns `undefined` if the session is locked or the
 * membership hasn't loaded — the caller then routes through the unlock gate.
 *
 * INV-10: the DEK is a transient `Uint8Array` held only in the session ref (browser memory). It is
 * never persisted, never put in a query cache, never logged. The membership BLOB is server-stored
 * (safe — it's wrapped to the caller's public key); the UNWRAPPED dek is not.
 */
export function useVaultDek(vaultId: string) {
  // Stable slice (key + unlock state) vs DEK slice (cache accessors) — SM-FE-006. The vault read-chain
  // legitimately reacts to DEK churn, so subscribing here to both contexts is intended.
  const { getPrivateKey, isUnlocked } = useSecretSession();
  const { getDek, hasDek, cacheDek } = useSecretDek();
  const { data: membership, isLoading: membershipLoading } = useMyMembership(vaultId);

  const ensureDek = useCallback((): Uint8Array | undefined => {
    const cached = getDek(vaultId);
    if (cached) return cached;

    const privateKey = getPrivateKey();
    if (!privateKey || !membership) return undefined;

    // Unwrap once from the caller's membership, then cache for the rest of the session.
    const dek = unwrapDekFromMembership(privateKey, membership);
    cacheDek(vaultId, dek);
    return dek;
  }, [vaultId, getPrivateKey, getDek, cacheDek, membership]);

  return {
    /** Cached-or-unwrap the vault DEK (browser memory only). `undefined` while locked / loading. */
    ensureDek,
    /** True once this vault's DEK is already in the session cache (reveal needs no unlock). */
    hasDek: hasDek(vaultId),
    /** The caller's own membership for this vault (the wrapped-DEK proof they can read it). */
    membership,
    /** True while the session private key is unlocked. */
    isUnlocked,
    /** True while the caller's membership is still loading. */
    membershipLoading,
  };
}
