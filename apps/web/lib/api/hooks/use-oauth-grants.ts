import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreatePersonalToken,
  OAuthAuthorizeDecision,
} from "@lazyit/shared";
import {
  createPersonalToken,
  decideAuthorizeRequest,
  getOAuthIssuer,
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
  issuer: () => ["ai", "oauth-issuer"] as const,
};

/**
 * The instance's configured address as the server knows it (the OAuth issuer) — what OAuth-mode install
 * snippets must use. Resolves to null when it cannot be read (never throws).
 */
export function useOAuthIssuer(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: oauthGrantKeys.issuer(),
    queryFn: () => getOAuthIssuer(),
    enabled: options.enabled ?? true,
    staleTime: 5 * 60 * 1000,
  });
}

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
 * Mint a personal MCP token. The response (with the cleartext token) is never put into a QUERY; but
 * TanStack keeps every mutation's result in the MUTATION cache until the mutation is reset or
 * garbage-collected. So `gcTime: 0` drops it as soon as nothing observes it, and the caller calls
 * `reset()` right after handing the token to its one-time reveal — the token then lives only in the
 * reveal's own state. Only the list is refetched.
 */
export function useCreatePersonalToken() {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (body: CreatePersonalToken) => createPersonalToken(body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: oauthGrantKeys.all }),
  });
}

/**
 * The consent page's decision. Its 403s (a refusal, a step-up code) are answers for the page, not a
 * logout; the global handlers only react to a 401 and to `PASSWORD_CHANGE_REQUIRED`. The variables
 * carry the step-up password and the response the authorization code, so — as for
 * {@link useCreatePersonalToken} — `gcTime: 0` and the caller's `reset()` keep neither in the mutation
 * cache.
 */
export function useOAuthConsentDecision() {
  return useMutation({
    gcTime: 0,
    mutationFn: (decision: OAuthAuthorizeDecision) =>
      decideAuthorizeRequest(decision),
  });
}
