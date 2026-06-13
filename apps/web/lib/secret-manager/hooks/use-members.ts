import type { CreateVaultMembership } from "@lazyit/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addMember,
  getMembers,
  getMyMembership,
  removeMember,
} from "../endpoints/members";
import { membershipKeys, vaultKeys } from "../query-keys";
import { skip4xxRetry } from "./retry";

/**
 * Read + write hooks for `VaultMembership` (ADR-0061 §4). The add-member body carries the DEK wrapped to
 * the target's public key (`wrapDekForMember(...)`), produced client-side from the granter's UNLOCKED
 * private key. The unwrapped DEK is never passed to these hooks or cached — only the wrapped blob crosses
 * the boundary ("no grant-what-you-can't-read", INV-10).
 */

/** List a vault's members (metadata only — no wrapped DEKs). */
export function useMembers(vaultId: string | undefined) {
  return useQuery({
    queryKey: membershipKeys.members(vaultId ?? ""),
    queryFn: () => getMembers(vaultId as string),
    enabled: Boolean(vaultId),
    // A 403 (removed from vault mid-session) is terminal. Skip 4xx retries so the list settles
    // immediately rather than hammering GET /members for 7 s (fix #444).
    retry: skip4xxRetry,
  });
}

/**
 * Fetch the caller's OWN membership (the wrapped-DEK row the browser unwraps to read the vault). This is
 * the first step of the read chain; the wrapped blob is ciphertext, safe to cache.
 *
 * A 403 (non-member) or 404 (vault gone) is a TERMINAL render-gating state — the vault can't be
 * unlocked. `retry` skips 4xx immediately; `retryOnMount: false` prevents a settled-error from re-firing
 * on remount; `refetchOnWindowFocus: false` suppresses refocus noise — mirrors the keypair fix (#442).
 */
export function useMyMembership(vaultId: string | undefined) {
  return useQuery({
    queryKey: membershipKeys.me(vaultId ?? ""),
    queryFn: () => getMyMembership(vaultId as string),
    enabled: Boolean(vaultId),
    retry: skip4xxRetry,
    retryOnMount: false,
    refetchOnWindowFocus: false,
  });
}

/**
 * Grant a member: post the target `userId` + the DEK wrapped to their public key. Invalidates the vault's
 * member list, the vault detail (members are embedded there), and the caller's own membership key so the
 * wrapped-DEK row cannot go stale (SM-FE-003 fix #444).
 */
export function useAddMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      vaultId,
      data,
    }: {
      vaultId: string;
      data: CreateVaultMembership;
    }) => addMember(vaultId, data),
    onSuccess: (_result, { vaultId }) => {
      queryClient.invalidateQueries({
        queryKey: membershipKeys.members(vaultId),
      });
      // SM-FE-003: also invalidate the caller's own membership row so the wrapped-DEK cannot go stale.
      queryClient.invalidateQueries({
        queryKey: membershipKeys.me(vaultId),
      });
      queryClient.invalidateQueries({ queryKey: vaultKeys.detail(vaultId) });
    },
  });
}

/**
 * Revoke a member (hard-drop their wrapped-DEK row). Invalidates the member list, the caller's own
 * membership (SM-FE-003), and vault detail. NOTE: a cached DEK is NOT crypto-revoked (hard revoke / DEK
 * rotation is deferred) — the UI must not imply it.
 */
export function useRemoveMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ vaultId, userId }: { vaultId: string; userId: string }) =>
      removeMember(vaultId, userId),
    onSuccess: (_result, { vaultId }) => {
      queryClient.invalidateQueries({
        queryKey: membershipKeys.members(vaultId),
      });
      // SM-FE-003: also invalidate the caller's own membership row so the wrapped-DEK cannot go stale.
      queryClient.invalidateQueries({
        queryKey: membershipKeys.me(vaultId),
      });
      queryClient.invalidateQueries({ queryKey: vaultKeys.detail(vaultId) });
    },
  });
}
