import type {
  CreateServiceAccount,
  UpdateServiceAccount,
} from "@lazyit/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createServiceAccount,
  getServiceAccount,
  getServiceAccounts,
  restoreServiceAccount,
  revokeServiceAccount,
  rotateServiceAccount,
  updateServiceAccount,
} from "../endpoints/service-accounts";
import { createQueryKeys } from "../query-keys";

/**
 * Query-key factory for the ServiceAccount resource (ADR-0020 shape + ADR-0048). `all` →
 * `["service-accounts"]`, `detail(id)` → `["service-accounts", "detail", id]`. The list is keyed by
 * the `includeRevoked` flag so the live view and the "show revoked" archived view are cached
 * distinctly (mutations invalidate `all`, refetching whichever is mounted).
 */
const baseServiceAccountKeys = createQueryKeys("service-accounts");
export const serviceAccountKeys = {
  ...baseServiceAccountKeys,
  list: (includeRevoked: boolean) =>
    [...baseServiceAccountKeys.all, "list", { includeRevoked }] as const,
};

/**
 * List service accounts. `includeRevoked=false` (default) is the live view; `true` also lists revoked
 * (soft-deleted) accounts for the archived/restore view. Returns the flat `ServiceAccount[]` — these
 * NEVER carry the secret (tokenPrefix only).
 */
export function useServiceAccounts(includeRevoked = false) {
  return useQuery({
    queryKey: serviceAccountKeys.list(includeRevoked),
    queryFn: () => getServiceAccounts(includeRevoked),
  });
}

/** Fetch a single service account by id; idle until an id is provided. Never carries the secret. */
export function useServiceAccount(id: string | undefined) {
  return useQuery({
    queryKey: serviceAccountKeys.detail(id ?? ""),
    queryFn: () => getServiceAccount(id as string),
    enabled: Boolean(id),
  });
}

/**
 * Create a service account (`POST /service-accounts`). The mutation RESOLVES with the once-only
 * {@link ServiceAccountWithSecret} (the full `lzit_sa_…` token) — the calling dialog reads it from the
 * `mutateAsync` result to show the secret-reveal panel. We deliberately do NOT write that response to
 * the query cache: only `all` is invalidated (so the list refetches the secret-free row), keeping the
 * cleartext token out of TanStack's store entirely. It is therefore never refetchable.
 */
export function useCreateServiceAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateServiceAccount) => createServiceAccount(data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: serviceAccountKeys.all }),
  });
}

/**
 * Rotate the token (`POST /service-accounts/:id/rotate`). Like create, it RESOLVES with the once-only
 * {@link ServiceAccountWithSecret} for the reveal panel and is NEVER cached — only `all` + the row's
 * detail are invalidated so the secret-free representation refetches. The old token stops working.
 */
export function useRotateServiceAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => rotateServiceAccount(id),
    onSuccess: (_result, id) => {
      queryClient.invalidateQueries({ queryKey: serviceAccountKeys.all });
      queryClient.invalidateQueries({
        queryKey: serviceAccountKeys.detail(id),
      });
    },
  });
}

/** Update a service account (rename/description/permissions/isActive/expiresAt — never the token). */
export function useUpdateServiceAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateServiceAccount }) =>
      updateServiceAccount(id, data),
    onSuccess: (_account, { id }) => {
      queryClient.invalidateQueries({ queryKey: serviceAccountKeys.all });
      queryClient.invalidateQueries({
        queryKey: serviceAccountKeys.detail(id),
      });
    },
  });
}

/** Revoke (soft-delete) a service account. Invalidates so both list views update. */
export function useRevokeServiceAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeServiceAccount(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: serviceAccountKeys.all }),
  });
}

/** Restore a revoked service account. Invalidates so the archived/live lists update. */
export function useRestoreServiceAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreServiceAccount(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: serviceAccountKeys.all }),
  });
}
