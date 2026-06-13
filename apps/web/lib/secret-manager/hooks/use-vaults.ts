import type { UpdateSecretVault } from "@lazyit/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type CreateSecretVaultBody,
  createVault,
  deleteVault,
  getVault,
  getVaults,
  updateVault,
} from "../endpoints/vaults";
import { membershipKeys, vaultKeys } from "../query-keys";

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
  });
}

/** Fetch one vault with its embedded member list. Metadata only. */
export function useVault(vaultId: string | undefined) {
  return useQuery({
    queryKey: vaultKeys.detail(vaultId ?? ""),
    queryFn: () => getVault(vaultId as string),
    enabled: Boolean(vaultId),
  });
}

/**
 * Create a vault. `body` = `{ name, membership }` where `membership` is the client-side self-wrap of the
 * DEK. Invalidates the vault list and the caller's membership view (they are now a member).
 */
export function useCreateVault() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSecretVaultBody) => createVault(body),
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

/** Soft-delete a vault. Invalidates the vault root (list + detail). */
export function useDeleteVault() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vaultId: string) => deleteVault(vaultId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: vaultKeys.all }),
  });
}
