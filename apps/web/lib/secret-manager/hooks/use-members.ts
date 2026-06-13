import type { CreateVaultMembership } from "@lazyit/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addMember,
  getMembers,
  getMyMembership,
  removeMember,
} from "../endpoints/members";
import { membershipKeys, vaultKeys } from "../query-keys";

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
  });
}

/**
 * Fetch the caller's OWN membership (the wrapped-DEK row the browser unwraps to read the vault). This is
 * the first step of the read chain; the wrapped blob is ciphertext, safe to cache.
 */
export function useMyMembership(vaultId: string | undefined) {
  return useQuery({
    queryKey: membershipKeys.me(vaultId ?? ""),
    queryFn: () => getMyMembership(vaultId as string),
    enabled: Boolean(vaultId),
  });
}

/**
 * Grant a member: post the target `userId` + the DEK wrapped to their public key. Invalidates the vault's
 * member list and the vault detail (members are embedded there).
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
      queryClient.invalidateQueries({ queryKey: vaultKeys.detail(vaultId) });
    },
  });
}

/**
 * Revoke a member (hard-drop their wrapped-DEK row). Invalidates the member list + vault detail. NOTE: a
 * cached DEK is NOT crypto-revoked (hard revoke / DEK rotation is deferred) — the UI must not imply it.
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
      queryClient.invalidateQueries({ queryKey: vaultKeys.detail(vaultId) });
    },
  });
}
