import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { EnqueueUpdate, UpdateSettings } from "@lazyit/shared";
import { isActiveUpdateRun, type UpdateRunStatus } from "@lazyit/shared";
import {
  enqueueUpdate,
  getInstanceVersion,
  getUpdateSettings,
  getUpdateStatus,
  putUpdateSettings,
} from "../endpoints/instance";

/**
 * Query-key factory for the `/instance` surface (ADR-0083 identity + ADR-0084 update awareness).
 */
export const instanceKeys = {
  all: ["instance"] as const,
  version: () => [...instanceKeys.all, "version"] as const,
  updateStatus: () => [...instanceKeys.all, "update-status"] as const,
  updateSettings: () => [...instanceKeys.all, "update-settings"] as const,
};

/**
 * The running build's version identity (`GET /instance/version`, ADR-0083). Authenticated read used
 * by Settings → Instance. The value is baked into the image at build time, so it can only change on
 * a redeploy — a long `staleTime` keeps this from refetching on every focus.
 */
export function useInstanceVersion() {
  return useQuery({
    queryKey: instanceKeys.version(),
    // Wrapped (not passed bare) so TanStack's QueryFunctionContext is never forwarded as the
    // getter's optional SSR `token` arg (ADR-0067); client callers always send no token.
    queryFn: () => getInstanceVersion(),
    staleTime: 60 * 60 * 1000,
  });
}

/**
 * The "Version & updates" card read (`GET /instance/update-status`, ADR-0084). While a run is in flight
 * the card polls faster (stage labels + the restart "reconnecting" window need to catch the new API); a
 * fetch failure during the ~60s restart is expected and rendered quietly, never a red toast. Otherwise a
 * relaxed staleTime — the cache only changes on the weekly check or an enqueue.
 */
export function useUpdateStatus() {
  return useQuery({
    queryKey: instanceKeys.updateStatus(),
    queryFn: () => getUpdateStatus(),
    staleTime: 60 * 1000,
    // Poll while an update is in flight so stages advance and the reconnecting→ready transition is caught.
    refetchInterval: (query) =>
      query.state.data?.activeRun &&
      isActiveUpdateRun(query.state.data.activeRun.status as UpdateRunStatus)
        ? 4000
        : false,
    // Same-origin polling survives the API restart; keep prior data so the card doesn't flash empty.
    placeholderData: (prev) => prev,
    retry: false,
  });
}

/** The update-check opt-in setting (`GET /instance/update-settings`, ADR-0084). */
export function useUpdateSettings() {
  return useQuery({
    queryKey: instanceKeys.updateSettings(),
    queryFn: () => getUpdateSettings(),
    staleTime: 60 * 1000,
  });
}

/** Flip the opt-in weekly check (`PUT /instance/update-settings`). Refreshes settings + the card. */
export function useUpdateUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateSettings) => putUpdateSettings(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: instanceKeys.updateSettings(),
      });
      void queryClient.invalidateQueries({
        queryKey: instanceKeys.updateStatus(),
      });
    },
  });
}

/**
 * Enqueue a guided update (`POST /instance/update`). On success the status card refetches to show the
 * new `activeRun` (status `requested`) and the operator is shown the `./infra/update.sh` command. This
 * records intent only — nothing runs on the host until the operator executes the printed command.
 */
export function useEnqueueUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: EnqueueUpdate) => enqueueUpdate(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: instanceKeys.updateStatus(),
      });
    },
  });
}
