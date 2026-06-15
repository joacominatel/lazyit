import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CloneUser, CreateUser, Role, UpdateUser } from "@lazyit/shared";
import { applicationKeys } from "./use-applications";
import { assetKeys } from "./use-assets";
import { invalidateDashboard } from "./use-dashboard";
import {
  cloneUser,
  createUser,
  deleteUser,
  offboardUser,
  resetUserPassword,
  restoreUser,
  updateUser,
} from "../endpoints/users";
import { userKeys } from "./use-users";

/**
 * Write hooks for the User resource. Each invalidates the users list on success
 * so the table refetches. Toasts and dialog state are owned by the calling
 * component, not here — these stay focused on the cache. Mirrors
 * use-location-mutations.ts (ADR-0020).
 */

export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateUser) => createUser(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: userKeys.all }),
  });
}

/**
 * Clone a user with chosen actions (`POST /users/:id/clone`, `user:manage` — ADR-0058). The heavier,
 * server-orchestrated sibling of the in-form clone pre-fill: it mints a NEW user AND mirrors the
 * source's selected active assignments + grants in one transaction, optionally firing the workflow
 * engine on the cloned grants. Invalidates more than a plain create — besides the users cache (the new
 * user joins the directory), it invalidates the assets and applications caches because the clone opens
 * new assignments + grants those screens must reflect — and the dashboard, whose summary counts and
 * activity feed derive from those new assignments + grants (issue #499). Toasts, the result view and
 * navigation stay with the calling component; this only keeps the cache coherent.
 */
export function useCloneUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sourceId, body }: { sourceId: string; body: CloneUser }) =>
      cloneUser(sourceId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: userKeys.all });
      queryClient.invalidateQueries({ queryKey: assetKeys.all });
      queryClient.invalidateQueries({ queryKey: applicationKeys.all });
      invalidateDashboard(queryClient);
    },
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateUser }) =>
      updateUser(id, data),
    onSuccess: (_user, { id }) => {
      queryClient.invalidateQueries({ queryKey: userKeys.all });
      queryClient.invalidateQueries({ queryKey: userKeys.detail(id) });
    },
  });
}

/**
 * Change a user's RBAC role (ADR-0040) via `PATCH /users/:id`. A focused mutation so the role Select
 * stays simple. Toasts/confirmation are owned by the calling component; this only keeps the cache
 * coherent — invalidating the list, the user's detail, AND `me` (the caller may have changed their
 * own role in some flow, and `me` carries the role the UI gates on). The API still enforces the
 * last-admin (409) and self-role-change (403) guards, surfaced as the mutation's error.
 */
export function useUpdateUserRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) =>
      updateUser(id, { role }),
    onSuccess: (_user, { id }) => {
      queryClient.invalidateQueries({ queryKey: userKeys.all });
      queryClient.invalidateQueries({ queryKey: userKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: userKeys.me() });
    },
  });
}

export function useDeleteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteUser(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: userKeys.all }),
  });
}

/**
 * Offboard a user (`POST /users/:id/offboard`, `user:manage`) — the intention-revealing alias of
 * DELETE that backs the Offboarding flow (Wave 3b). Soft-deletes the user and, in one transaction,
 * revokes ALL their active grants and releases ALL their active assignments; resolves to the
 * {@link OffboardResult} summary so the caller can show an honest "released N / revoked M" confirmation.
 *
 * Invalidates more than the plain delete: besides the users cache (so the directory + per-person
 * panels refetch), it invalidates the assets and applications caches because the reclaimed assets
 * are now unassigned and the revoked grants are now closed — and the dashboard, whose summary counts
 * and activity feed derive from those released assignments + revoked grants (issue #499). Toasts,
 * the success animation and navigation stay with the calling component.
 */
export function useOffboardUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => offboardUser(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: userKeys.all });
      queryClient.invalidateQueries({ queryKey: assetKeys.all });
      queryClient.invalidateQueries({ queryKey: applicationKeys.all });
      invalidateDashboard(queryClient);
    },
  });
}

/**
 * Restore (re-onboard) a soft-deleted user (ADMIN, ADR-0041). Invalidates the users cache so the
 * archived list updates; the API does NOT re-grant the user's prior access/assignments.
 */
export function useRestoreUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreUser(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: userKeys.all }),
  });
}

/**
 * Trigger an IdP-driven password reset for a user (`POST /users/:id/reset-password`, `user:manage`).
 * The IdP (Zitadel) emails the reset link via its own SMTP — lazyit never sets the password, so there
 * is nothing in our cache to invalidate. Toasts and the honest 501/422/404 handling are owned by the
 * calling component (mapped on the {@link ApiError}'s `.status`); this only wraps the request.
 */
export function useResetUserPassword() {
  return useMutation({
    mutationFn: (id: string) => resetUserPassword(id),
  });
}
