import type {
  CreateSecretVaultWithMembership,
  ExportSecretsAudit,
  UpdateSecretVault,
} from "@lazyit/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createVault,
  deleteVault,
  getVault,
  getVaults,
  recordExport,
  updateVault,
} from "../endpoints/vaults";
import { membershipKeys, vaultKeys } from "../query-keys";
import { skip4xxRetry } from "./retry";

/**
 * Read + write hooks for `SecretVault` (ADR-0061 §2). Vaults carry only metadata (name + members); the
 * create body includes the creator's wrapped-DEK self-wrap (`createVaultMaterial(...).selfWrap`),
 * produced client-side. The raw DEK is never passed to these hooks or cached.
 */

/** List the vaults the caller can see. Metadata only. */
export function useVaults() {
  return useQuery({
    queryKey: vaultKeys.list(),
    queryFn: getVaults,
    // A 403 mid-session (permissions revoked) is terminal. Skip 4xx immediately (fix #444).
    retry: skip4xxRetry,
  });
}

/** Fetch one vault with its embedded member list. Metadata only. */
export function useVault(vaultId: string | undefined) {
  return useQuery({
    queryKey: vaultKeys.detail(vaultId ?? ""),
    queryFn: () => getVault(vaultId as string),
    enabled: Boolean(vaultId),
    // A 403 (non-member) or 404 (deleted vault) is terminal for the detail view. Skip 4xx (fix #444).
    retry: skip4xxRetry,
  });
}

/**
 * Create a vault. `body` = `{ name, membership }` where `membership` is the client-side self-wrap of the
 * DEK. Invalidates the vault list and the caller's membership view (they are now a member).
 */
export function useCreateVault() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSecretVaultWithMembership) => createVault(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: vaultKeys.all });
      queryClient.invalidateQueries({ queryKey: membershipKeys.all });
    },
  });
}

/** Rename a vault. Invalidates the vault root so the list + detail re-read. */
export function useUpdateVault() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      vaultId,
      data,
    }: {
      vaultId: string;
      data: UpdateSecretVault;
    }) => updateVault(vaultId, data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: vaultKeys.all }),
  });
}

/**
 * Record a vault secret export (#612) — the metadata-only audit call AFTER the browser has decrypted the
 * items and triggered the `.env` download. No cache invalidation (it mutates only the server-side audit
 * log, nothing the UI reads). INV-10: the body carries no secret material.
 */
export function useRecordExport() {
  return useMutation({
    mutationFn: ({
      vaultId,
      audit,
    }: {
      vaultId: string;
      audit?: ExportSecretsAudit;
    }) => recordExport(vaultId, audit),
  });
}

/** Soft-delete a vault. Invalidates the vault root (list + detail). */
export function useDeleteVault() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vaultId: string) => deleteVault(vaultId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: vaultKeys.all }),
  });
}
