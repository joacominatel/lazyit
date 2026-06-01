import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SetupAdmin } from "@lazyit/shared";
import { getConfigStatus, setupConfig } from "../endpoints/config";
import { userKeys } from "./use-users";

/**
 * Query-key factory for the first-run `/config` surface (ADR-0043 Phase 3, ADR-0020 data layer).
 * A single key — the status read drives the whole wizard + the banners.
 */
export const configKeys = {
  all: ["config"] as const,
  status: () => [...["config"], "status"] as const,
};

/**
 * First-run status (`GET /config/status`). Public — works before any login. Used by:
 *   - the `/setup` wizard (self-locks when `isConfigured`),
 *   - the topbar dev-mode banner (`devMode`),
 *   - the Users page BYOI banner (`integrationMode === "generic-oidc"`).
 *
 * `staleTime` is short and the data refetches on focus so a freshly-completed setup (or an operator
 * flipping env) is reflected without a hard reload, but a stale read never gates anything the API
 * doesn't already enforce server-side.
 */
export function useConfigStatus() {
  return useQuery({
    queryKey: configKeys.status(),
    queryFn: getConfigStatus,
    staleTime: 30 * 1000,
  });
}

/**
 * Create the first ADMIN (`POST /config/setup`). On success it invalidates BOTH the config status
 * (so the wizard self-locks / banners update) and `GET /users/me` (so the new ADMIN's controls light
 * up immediately once they log in). Toasts + the redirect are owned by the calling wizard component.
 */
export function useSetupMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      data,
      csrfToken,
    }: {
      data: SetupAdmin;
      csrfToken: string;
    }) => setupConfig(data, csrfToken),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: configKeys.all });
      void queryClient.invalidateQueries({ queryKey: userKeys.me() });
    },
  });
}
