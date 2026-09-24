import type {
  CreatePersonalToken,
  OAuthAuthorizeDecision,
  OAuthAuthorizeParams,
  OAuthAuthorizeRedirect,
  OAuthAuthorizeValidation,
  OAuthGrant,
  PersonalTokenCreated,
} from "@lazyit/shared";
import { apiFetch, apiFetchBlob } from "../client";

/**
 * Data access for the OAuth side of the AI assistant (ADR-0097; docs/ai-assistant/mcp-and-oauth.md §12–§14,
 * frontend.md §7 K7–K8): the consent page's two calls, connected apps (OAuth grants and personal tokens)
 * and the Claude Code plugin download. Browser paths sit under `/api` (Caddy strips it).
 */

/**
 * `POST /oauth/authorize/validate` — what the consent screen shows, or a typed refusal (200). Called by
 * the consent page's Server Component with the session's token. 400 `{ error, redirectTo }` is a request
 * error that belongs to the client; 404 means this instance has no authorization server.
 */
export function validateAuthorizeRequest(
  params: OAuthAuthorizeParams,
  token: string,
): Promise<OAuthAuthorizeValidation> {
  return apiFetch<OAuthAuthorizeValidation>("/oauth/authorize/validate", {
    method: "POST",
    body: params,
    token,
    cache: "no-store",
  });
}

/**
 * `POST /oauth/authorize/decision` — approve (with the granted scopes, and the password when
 * `lazyit.admin` is among them) or deny. The API re-validates every parameter. Bearer-authenticated, so
 * a cross-site form cannot submit it (no cookie CSRF surface).
 */
export function decideAuthorizeRequest(
  decision: OAuthAuthorizeDecision,
): Promise<OAuthAuthorizeRedirect> {
  return apiFetch<OAuthAuthorizeRedirect>("/oauth/authorize/decision", {
    method: "POST",
    body: decision,
  });
}

/** `GET /oauth/grants/mine` — the caller's live connections: OAuth apps and personal tokens (`ai:connect`). */
export function listMyGrants(): Promise<OAuthGrant[]> {
  return apiFetch<OAuthGrant[]>("/oauth/grants/mine");
}

/** An admin list item: the shared grant plus its owner. */
export type AdminOAuthGrant = OAuthGrant & { userId: string };

/** `GET /oauth/grants?userId=` — everyone's connections, or one user's (`settings:manage`). */
export function listAllGrants(userId?: string): Promise<AdminOAuthGrant[]> {
  const query = userId ? `?${new URLSearchParams({ userId })}` : "";
  return apiFetch<AdminOAuthGrant[]>(`/oauth/grants${query}`);
}

/**
 * `DELETE /oauth/grants/:id` — revoke a connection (OAuth app or personal token). The owner always; an
 * admin (`settings:manage`) for anyone's. Takes effect on the client's next request.
 */
export function revokeGrant(id: string): Promise<void> {
  return apiFetch<void>(`/oauth/grants/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/**
 * `POST /oauth/personal-tokens` — mint a personal MCP token (plain-HTTP instances only). The cleartext
 * token comes back exactly once; the caller shows it and drops it (never cached).
 * 403 `{ code: "OAUTH_INSTANCE" | "AI_DISABLED" }` says why it cannot be minted; 409 past the per-user cap.
 */
export function createPersonalToken(
  body: CreatePersonalToken,
): Promise<PersonalTokenCreated> {
  return apiFetch<PersonalTokenCreated>("/oauth/personal-tokens", {
    method: "POST",
    body,
    cache: "no-store",
  });
}

/**
 * `GET /ai/claude-code/plugin.zip` — the Claude Code plugin (the lazyit skill + `.mcp.json`), pre-filled
 * with this instance's address (`ai:connect`). 404 while MCP is off; 409 `ORIGIN_UNKNOWN` when the
 * instance does not know its own address.
 */
export function downloadClaudeCodePlugin(): Promise<Blob> {
  return apiFetchBlob("/ai/claude-code/plugin.zip");
}
