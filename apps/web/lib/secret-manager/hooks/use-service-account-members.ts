import type {
  CreateServiceAccountKeypair,
  CreateServiceAccountVaultMembership,
} from "@lazyit/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addServiceAccountMember,
  createServiceAccountKeypair,
  getServiceAccountMembers,
  getServiceAccountPublicKey,
  removeServiceAccountMember,
} from "../endpoints/service-account-members";
import { membershipKeys, saKeypairKeys, vaultKeys } from "../query-keys";
import { skip4xxRetry } from "./retry";

/**
 * List a vault's SERVICE-ACCOUNT members (metadata only — no wrapped DEKs). The machine-member sibling of
 * `useMembers`; the vault-detail Members section merges the two so a granted SA is visible and revocable
 * (#888). A 403 (removed from the vault mid-session) is terminal — skip 4xx retries so the list settles.
 */
export function useServiceAccountMembers(vaultId: string | undefined) {
  return useQuery({
    queryKey: membershipKeys.serviceAccountMembers(vaultId ?? ""),
    queryFn: () => getServiceAccountMembers(vaultId as string),
    enabled: Boolean(vaultId),
    retry: skip4xxRetry,
  });
}

/**
 * Read + write hooks for the SERVICE-ACCOUNT crypto surface (ADR-0080). The keypair-bootstrap and
 * grant DTOs are produced CLIENT-SIDE (`crypto.ts#bootstrapServiceAccountKeypair` / `wrapDekForMember`) —
 * public keys + wrapped blobs only. NOTHING secret (the SA token, its private key, the DEK) is passed to
 * these hooks, cached, or logged (INV-10).
 */

/**
 * Fetch a service account's public key — the wrap target when granting it a vault. `enabled` guards the
 * empty case so the lookup only runs once an SA is chosen. A 404 (the SA has no keypair — it was never
 * created with the Fetch permission) is TERMINAL: we cannot wrap a DEK for it. `retry` skips 4xx
 * immediately; `retryOnMount`/`refetchOnWindowFocus` off so the settled-error doesn't re-fire (mirrors
 * `useUserPublicKey`).
 */
export function useServiceAccountPublicKey(saId: string | undefined) {
  return useQuery({
    queryKey: saKeypairKeys.publicKey(saId ?? ""),
    queryFn: () => getServiceAccountPublicKey(saId as string),
    enabled: Boolean(saId),
    retry: skip4xxRetry,
    retryOnMount: false,
    refetchOnWindowFocus: false,
  });
}

/**
 * Bootstrap a service account's keypair (`POST …/:saId/keypair`). `data` is the
 * {@link CreateServiceAccountKeypair} wire DTO produced client-side while the SA token is in memory — the
 * token itself is never sent. Invalidates the SA's public-key query so a subsequent grant sees it.
 */
export function useCreateServiceAccountKeypair() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      saId,
      data,
    }: {
      saId: string;
      data: CreateServiceAccountKeypair;
    }) => createServiceAccountKeypair(saId, data),
    onSuccess: (_result, { saId }) => {
      queryClient.invalidateQueries({
        queryKey: saKeypairKeys.publicKey(saId),
      });
    },
  });
}

/**
 * Grant a service account as a crypto member of a vault. `data` carries the target `serviceAccountId` +
 * the DEK wrapped to its public key. Invalidates the vault's member list + detail so any embedded view
 * refreshes (the human member list is unaffected, but keeping the pattern is cheap and safe). A 409
 * (already a member) surfaces to the caller.
 */
export function useAddServiceAccountMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      vaultId,
      data,
    }: {
      vaultId: string;
      data: CreateServiceAccountVaultMembership;
    }) => addServiceAccountMember(vaultId, data),
    onSuccess: (_result, { vaultId }) => {
      // #888: refresh the SA-members list so the newly-granted machine member appears immediately.
      queryClient.invalidateQueries({
        queryKey: membershipKeys.serviceAccountMembers(vaultId),
      });
      queryClient.invalidateQueries({
        queryKey: membershipKeys.members(vaultId),
      });
      queryClient.invalidateQueries({ queryKey: vaultKeys.detail(vaultId) });
    },
  });
}

/**
 * Revoke a service account's vault membership (hard-drop the wrapped-DEK row). Invalidates the member
 * list + vault detail. A 404 (not a member) surfaces to the caller. NOTE: a DEK the SA already cached is
 * NOT crypto-revoked (rotate the token + re-issue the keypair for a real compromise).
 */
export function useRemoveServiceAccountMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ vaultId, saId }: { vaultId: string; saId: string }) =>
      removeServiceAccountMember(vaultId, saId),
    onSuccess: (_result, { vaultId }) => {
      // #888: refresh the SA-members list so the revoked machine member disappears immediately.
      queryClient.invalidateQueries({
        queryKey: membershipKeys.serviceAccountMembers(vaultId),
      });
      queryClient.invalidateQueries({
        queryKey: membershipKeys.members(vaultId),
      });
      queryClient.invalidateQueries({ queryKey: vaultKeys.detail(vaultId) });
    },
  });
}
