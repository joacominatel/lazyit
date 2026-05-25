import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateUser, UpdateUser } from "@lazyit/shared";
import { createUser, deleteUser, updateUser } from "../endpoints/users";
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

export function useDeleteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteUser(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: userKeys.all }),
  });
}
