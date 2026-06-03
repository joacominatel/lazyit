import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateUser, Role, UpdateUser } from "@lazyit/shared";
import {
  createUser,
  deleteUser,
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
