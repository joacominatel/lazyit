import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreatePersonalToken,
  OAuthAuthorizeDecision,
} from "@lazyit/shared";
import {
  createPersonalToken,
  decideAuthorizeRequest,
  listAllGrants,
  listMyGrants,
  revokeGrant,
} from "../endpoints/oauth";

/**
 * Connected apps (OAuth grants and personal MCP tokens) and the consent decision — ADR-0020 mold.
 * Keys live under the single AI root `["ai", …]` (docs/ai-assistant/frontend.md §5.2), so the chat's
 * "invalidate everything but the assistant" predicate leaves them alone.
 */
export const oauthGrantKeys = {
  all: ["ai", "oauth-grants"] as const,
  mine: () => [...oauthGrantKeys.all, "mine"] as const,
  admin: (userId?: string) =>
    [...oauthGrantKeys.all, "admin", userId ?? "all"] as const,
};

/** The caller's live connections (`GET /oauth/grants/mine`, `ai:connect`). */
export function useMyOAuthGrants(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: oauthGrantKeys.mine(),
    queryFn: () => listMyGrants(),
    enabled: options.enabled ?? true,
  });
}

/** Everyone's connections, or one user's (`GET /oauth/grants?userId=`, `settings:manage`) — Settings → AI. */
export function useAllOAuthGrants(
  userId?: string,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: oauthGrantKeys.admin(userId),
    queryFn: () => listAllGrants(userId),
    enabled: options.enabled ?? true,
  });
}

/** Revoke one connection (`DELETE /oauth/grants/:id`); refreshes both the personal and the admin lists. */
export function useRevokeOAuthGrant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeGrant(id),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: oauthGrantKeys.all }),
  });
}

/**
 * Mint a personal MCP token. The returned token is handed to the caller's one-time reveal and never
 * written to the query cache — only the list is refetched.
 */
export function useCreatePersonalToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreatePersonalToken) => createPersonalToken(body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: oauthGrantKeys.all }),
  });
}

/**
 * The consent page's decision. Its 403s (a refusal, a step-up code) are answers for the page, not a
 * logout; the global handlers only react to a 401 and to `PASSWORD_CHANGE_REQUIRED`.
 */
export function useOAuthConsentDecision() {
  return useMutation({
    mutationFn: (decision: OAuthAuthorizeDecision) =>
      decideAuthorizeRequest(decision),
  });
}
