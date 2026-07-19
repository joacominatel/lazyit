import type { UpdateDirectoryConnection } from "@lazyit/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getDirectoryConnection,
  syncDirectoryNow,
  updateDirectoryConnection,
} from "../endpoints/directory";
import { userKeys } from "./use-users";

/**
 * Query keys for the singleton AD/LDAP directory connection (issue #839, ADR-0091). Like `smtpKeys`, this
 * is ONE config row (no list / detail) — a single `single()` key is the whole resource; `all` is the
 * invalidation prefix the PUT + sync mutations refetch. Namespaced under `config` for symmetry with the
 * rest of the instance-config surface.
 */
export const directoryKeys = {
  all: ["config", "directory"] as const,
  single: () => [...["config", "directory"], "single"] as const,
};

/**
 * Read the directory connection (`GET /directory/connection`, `settings:manage`). Drives the Settings →
 * Instance → Directory editor: seeds the form, the redacted "bind password configured" state, and the
 * last-sync result panel. The API never 404s for "unset" — it returns an explicit `enabled: false`
 * default — so `data` is a concrete shape whenever the query resolves. `staleTime` is short so a
 * freshly-saved config (or a fresh sync's cached counts) is reflected without a hard reload; the API's
 * guard is the real gate, so a stale read never authorizes anything.
 */
export function useDirectoryConnection() {
  return useQuery({
    queryKey: directoryKeys.single(),
    queryFn: ({ signal }) => getDirectoryConnection(signal),
    staleTime: 30 * 1000,
  });
}

/**
 * Upsert the directory connection (`PUT /directory/connection`, `settings:manage`). On success it
 * invalidates the directory query so the editor re-seeds from the persisted truth (the recomputed
 * `bindPasswordSet`, the trimmed fields). Toasts / validation-state are owned by the calling editor (a
 * 409 — bind password sent with DIRECTORY_SECRET_KEY unset — surfaces via `notifyError`).
 */
export function useUpdateDirectoryConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateDirectoryConnection) =>
      updateDirectoryConnection(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: directoryKeys.all });
    },
  });
}

/**
 * Run the directory sync now (`POST /directory/sync`, `settings:manage`). Always resolves HTTP 200; the
 * editor inspects the `{ ok, error, counts }` result to toast success/failure. On success it invalidates
 * BOTH the directory query (so the cached `lastSync*` fields on the row refresh) AND the users list (a
 * run may have created/refreshed/offboarded directory persons the review tray reads).
 */
export function useSyncDirectoryNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => syncDirectoryNow(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: directoryKeys.all });
      void queryClient.invalidateQueries({ queryKey: userKeys.all });
    },
  });
}
