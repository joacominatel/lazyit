/**
 * The fixed numbers of lazyit's OAuth 2.1 authorization server (ADR-0097 decision 8 and default 14;
 * docs/ai-assistant/_synthesis.md §4.8; mcp-and-oauth.md §5.2). Changing one is a security decision, not
 * a tuning knob, so they are constants rather than settings.
 */

/** Authorization codes are single-use and live 60 seconds (INV-AI-9). */
export const AUTHORIZATION_CODE_TTL_MS = 60 * 1000;

/** Access tokens (`lzit_oat_`) live one hour. */
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Refresh tokens (`lzit_ort_`) live 30 days from their issuance, i.e. from the last refresh. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A rotated refresh token presented again within this window is a benign concurrent-refresh race and
 * answers `invalid_grant` without revoking; outside it, the presentation is reuse and revokes the grant.
 */
export const REFRESH_REUSE_GRACE_MS = 30 * 1000;

/** `OAuthGrant.lastUsedAt` is stamped at most once per this interval (a write per request is waste). */
export const GRANT_LAST_USED_THROTTLE_MS = 60 * 1000;

/** The scopes an authorization request without `scope` asks for. `lazyit.admin` is never implied. */
export const DEFAULT_REQUESTED_SCOPES = [
  'lazyit.read',
  'lazyit.write',
] as const;

/** Prefix of a dynamically registered client id. */
export const DCR_CLIENT_ID_PREFIX = 'lzc_';

/** Upper bound on the redirect URIs one registration may carry. */
export const DCR_MAX_REDIRECT_URIS = 10;

/** Display name of a client that registered without one. */
export const DCR_UNNAMED_CLIENT = 'Unnamed client';

/**
 * Global cap on dynamically registered clients created in the last 24 h that never obtained a grant.
 * Past it, registration answers 429 until the sweeper collects the unused ones (DCR abuse, security §6.3).
 */
export const DCR_MAX_PENDING_REGISTRATIONS = 500;

/** Unused DCR clients (never exchanged a code, no grant) are hard-deleted after this long. */
export const DCR_UNUSED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;

/** Rate limits (per-replica, in-memory — the LoginRateLimitGuard posture). */
export const REGISTER_RATE_LIMIT = { max: 10, windowMs: 60 * 60 * 1000 };
export const TOKEN_RATE_LIMIT = { max: 60, windowMs: 60 * 1000 };
export const REVOKE_RATE_LIMIT = { max: 60, windowMs: 60 * 1000 };
/** Per user: the decision endpoint verifies a password for `lazyit.admin`, so it is brute-force bounded. */
export const CONSENT_DECISION_RATE_LIMIT = { max: 10, windowMs: 60 * 1000 };

/** How often the sweeper collects expired codes, tokens and unused DCR clients. */
export const OAUTH_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
