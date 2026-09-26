import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UserSessionList } from "@lazyit/shared";

import { ApiError } from "../client";
import { useClientOnlyQuery } from "../client-only-query";
import { endMySession, listMySessions } from "../endpoints/auth-session";

/** Query keys for the caller's own per-device sessions (#1420). */
export const mySessionKeys = {
  all: ["auth", "sessions"] as const,
  list: () => [...mySessionKeys.all, "list"] as const,
};

/**
 * The caller's signed-in devices (`GET /auth/sessions`, ADR-0086 §9). Only meaningful in local mode, so
 * the caller passes `enabled` from `authMode === "local"` and an OIDC instance never asks.
 *
 * No route prefetches this query, so it goes through {@link useClientOnlyQuery} (#1448, ADR-0067): during
 * hydration it reads exactly what the server rendered (pending), which keeps the relative "last active"
 * times out of the server HTML.
 */
export function useMySessions(enabled: boolean) {
  return useClientOnlyQuery(
    useQuery<UserSessionList>({
      queryKey: mySessionKeys.list(),
      queryFn: () => listMySessions(),
      enabled,
      staleTime: 30 * 1000,
    }),
  );
}

/**
 * End one of the caller's sessions (`DELETE /auth/sessions/:id`). The list is refreshed on success, and on a 404 (the row was already gone). Ending the
 * CURRENT session answers 204 and the component then signs this device out itself; the refresh is skipped
 * in that case because the token is already dead. A 401 (this session was already ended elsewhere) flows
 * through the global auth-expiry reaction like any other mutation.
 */
export function useEndMySession() {
  const queryClient = useQueryClient();
  return useMutation<void, unknown, { id: string; current: boolean }>({
    mutationFn: ({ id }) => endMySession(id),
    onSuccess: (_result, { current }) => {
      if (!current) {
        void queryClient.invalidateQueries({ queryKey: mySessionKeys.all });
      }
    },
    // A 404 means the row was already gone (ended elsewhere, swept): the list was stale, refresh it.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 404) {
        void queryClient.invalidateQueries({ queryKey: mySessionKeys.all });
      }
    },
  });
}
