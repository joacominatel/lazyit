import { z } from "zod";
import { int4 } from "./primitives";

/**
 * lazyit's OAuth 2.1 authorization server for MCP, and the personal MCP tokens of `lan` instances
 * (ADR-0097 decisions 8 and 9; docs/ai-assistant/_synthesis.md §4.7–4.8, reconciliation R7;
 * mcp-and-oauth.md §5–6). No OIDC surface (INV-AI-13): no `id_token`, no userinfo.
 *
 * Tokens are opaque, 256-bit, stored only as a SHA-256 hash, and accepted ONLY on `/mcp`. The wire
 * shapes below never carry a token hash; a cleartext token appears exactly once, in the response that
 * mints it.
 */

/** Access token prefix (1 h). */
export const OAUTH_ACCESS_TOKEN_PREFIX = "lzit_oat_" as const;
/** Refresh token prefix (30 days from last use, rotated on every use). */
export const OAUTH_REFRESH_TOKEN_PREFIX = "lzit_ort_" as const;
/** Personal MCP token prefix (`lan` instances only; mandatory expiry). */
export const PERSONAL_TOKEN_PREFIX = "lzit_pat_" as const;

/**
 * The three scopes (R7). Each one unlocks one tool class over MCP: `lazyit.read` → `read`,
 * `lazyit.write` → `write`, `lazyit.admin` → `elevated`. `lazyit.admin` is never preselected at consent
 * and needs a password step-up.
 */
export const OAUTH_SCOPES = ["lazyit.read", "lazyit.write", "lazyit.admin"] as const;
export const OAuthScopeSchema = z.enum(OAUTH_SCOPES);
export type OAuthScope = z.infer<typeof OAuthScopeSchema>;

/**
 * The `scope` request parameter (RFC 6749 §3.3): space-delimited, order-insensitive. Parses to a
 * de-duplicated list in catalog order. An empty value or any unknown scope is refused — the authorization
 * server never silently narrows a request it does not understand.
 */
export const OAuthScopeParamSchema = z
  .string()
  .max(512)
  .transform((raw) => [...new Set(raw.split(" ").filter((token) => token.length > 0))])
  .pipe(z.array(OAuthScopeSchema).min(1, "At least one scope is required"))
  .transform((scopes) => OAUTH_SCOPES.filter((scope) => scopes.includes(scope)));

/** Serialize scopes back to the space-delimited parameter form, in catalog order. */
export function formatOAuthScopes(scopes: readonly OAuthScope[]): string {
  return OAUTH_SCOPES.filter((scope) => scopes.includes(scope)).join(" ");
}

/** How a client came to be known: registered (DCR), a fetched metadata document (CIMD), or bundled. */
export const OAUTH_CLIENT_KINDS = ["dcr", "cimd", "known"] as const;
export const OAuthClientKindSchema = z.enum(OAUTH_CLIENT_KINDS);
export type OAuthClientKind = z.infer<typeof OAuthClientKindSchema>;

/** A "connected app" is an OAuth delegation or a personal token. */
export const OAUTH_GRANT_KINDS = ["oauth", "personal"] as const;
export const OAuthGrantKindSchema = z.enum(OAUTH_GRANT_KINDS);
export type OAuthGrantKind = z.infer<typeof OAuthGrantKindSchema>;

/** The token rows a grant owns (`OAuthToken.kind`). */
export const OAUTH_TOKEN_KINDS = ["access", "refresh", "personal"] as const;
export const OAuthTokenKindSchema = z.enum(OAUTH_TOKEN_KINDS);
export type OAuthTokenKind = z.infer<typeof OAuthTokenKindSchema>;

/** Why a grant was revoked (`OAuthGrant.revokeReason`). */
export const OAUTH_GRANT_REVOKE_REASONS = [
  "user",
  "admin",
  "refresh_reuse",
  "revocation_endpoint",
  "client_deleted",
] as const;
export const OAuthGrantRevokeReasonSchema = z.enum(OAUTH_GRANT_REVOKE_REASONS);
export type OAuthGrantRevokeReason = z.infer<typeof OAuthGrantRevokeReasonSchema>;

/** The events of the append-only `oauth_audit_log` (ADR-0081 source `oauth`). */
export const OAUTH_AUDIT_ACTIONS = [
  "CLIENT_REGISTERED",
  "GRANT_CREATED",
  "CONSENT_DENIED",
  "GRANT_REVOKED",
  "REFRESH_REUSE_DETECTED",
  "PERSONAL_TOKEN_CREATED",
  "PERSONAL_TOKEN_REVOKED",
] as const;
export const OAuthAuditActionSchema = z.enum(OAUTH_AUDIT_ACTIONS);
export type OAuthAuditAction = z.infer<typeof OAuthAuditActionSchema>;

/**
 * One connected app, as `GET /oauth/grants/mine` (and the admin `GET /oauth/grants?userId=`) list it.
 * `client.verified` is true for a CIMD client whose metadata document was fetched from its own https
 * `client_id` URL; a DCR client's name is self-declared.
 */
export const OAuthGrantSchema = z.object({
  id: z.cuid(),
  kind: OAuthGrantKindSchema,
  client: z.object({ name: z.string(), verified: z.boolean() }).nullable(),
  /** The personal token's name; null for an OAuth grant. */
  label: z.string().nullable(),
  /** The host the client redirects to; null for a personal token. */
  redirectHost: z.string().nullable(),
  scopes: z.array(OAuthScopeSchema),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  /** Always set for a personal token (mandatory expiry); null for an OAuth grant. */
  expiresAt: z.iso.datetime().nullable(),
});
export type OAuthGrant = z.infer<typeof OAuthGrantSchema>;

/** Personal token lifetime, in days: 90 by default, 365 at most, always with an expiry. */
export const PERSONAL_TOKEN_DEFAULT_EXPIRY_DAYS = 90;
export const PERSONAL_TOKEN_MAX_EXPIRY_DAYS = 365;

/**
 * The scopes a personal token may carry: "Read only" or "Read & write", like the consent screen's two
 * everyday choices. `lazyit.admin` is not offered: a personal token is long-lived (up to a year) and
 * minted without a client to show, so the `elevated` tools stay behind OAuth consent with a step-up.
 */
export const PERSONAL_TOKEN_SCOPES = ["lazyit.read", "lazyit.write"] as const;
export const PersonalTokenScopeSchema = z.enum(PERSONAL_TOKEN_SCOPES);

/** What a personal token carries when the request names no scopes (the consent screen's preselection). */
export const PERSONAL_TOKEN_DEFAULT_SCOPES: readonly OAuthScope[] = ["lazyit.read", "lazyit.write"];

/**
 * `POST /oauth/personal-tokens` (`lan` instances only). `scopes` is optional (absent = read & write) and
 * parses to a de-duplicated list in catalog order.
 */
export const CreatePersonalTokenSchema = z.strictObject({
  label: z.string().trim().min(1).max(120),
  expiresInDays: int4({ min: 1, max: PERSONAL_TOKEN_MAX_EXPIRY_DAYS }).default(
    PERSONAL_TOKEN_DEFAULT_EXPIRY_DAYS,
  ),
  scopes: z
    .array(PersonalTokenScopeSchema)
    .min(1)
    .max(PERSONAL_TOKEN_SCOPES.length * 2)
    .optional()
    .transform((scopes): OAuthScope[] =>
      scopes === undefined
        ? [...PERSONAL_TOKEN_DEFAULT_SCOPES]
        : OAUTH_SCOPES.filter((scope) => (scopes as readonly string[]).includes(scope)),
    ),
});
export type CreatePersonalToken = z.infer<typeof CreatePersonalTokenSchema>;

/** The minted personal token — the cleartext `token` is shown exactly once and never again. */
export const PersonalTokenCreatedSchema = z.object({
  token: z.string().startsWith(PERSONAL_TOKEN_PREFIX),
  grant: OAuthGrantSchema,
});
export type PersonalTokenCreated = z.infer<typeof PersonalTokenCreatedSchema>;

/**
 * The raw authorization-request parameters the consent page forwards to
 * `POST /oauth/authorize/validate` and `/decision`. They are only shape-checked here; the API validates
 * their meaning (client, exact redirect match, PKCE S256, resource, scopes) and re-validates everything
 * on the decision.
 */
export const OAuthAuthorizeParamsSchema = z.object({
  response_type: z.string().max(64),
  client_id: z.string().min(1).max(2048),
  redirect_uri: z.string().min(1).max(2048),
  code_challenge: z.string().min(1).max(256),
  code_challenge_method: z.string().max(16),
  state: z.string().max(2048).optional(),
  scope: z.string().max(512).optional(),
  resource: z.string().max(2048).optional(),
});
export type OAuthAuthorizeParams = z.infer<typeof OAuthAuthorizeParamsSchema>;

/**
 * Why the consent page cannot proceed. An invalid client or redirect renders an error page and NEVER
 * redirects (RFC 6749 §4.1.2.1).
 */
export const OAUTH_AUTHORIZE_REFUSALS = [
  "AI_DISABLED",
  "FORBIDDEN",
  "INVALID_CLIENT",
  "INVALID_REDIRECT",
] as const;
export const OAuthAuthorizeRefusalSchema = z.enum(OAUTH_AUTHORIZE_REFUSALS);
export type OAuthAuthorizeRefusal = z.infer<typeof OAuthAuthorizeRefusalSchema>;

/**
 * `POST /oauth/authorize/validate` response, discriminated on `ok`: what the consent screen shows, or a
 * typed refusal.
 */
export const OAuthAuthorizeValidationSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    client: z.object({
      id: z.string().min(1),
      name: z.string(),
      uri: z.string().nullable(),
      verified: z.boolean(),
    }),
    redirectUri: z.string().min(1),
    redirectHost: z.string().min(1),
    /** The redirect is a loopback address — the consent screen shows an extra warning. */
    loopbackOnly: z.boolean(),
    /** The scopes the client asked for. */
    scopes: z.array(OAuthScopeSchema),
    user: z.object({ email: z.string() }),
  }),
  z.object({ ok: z.literal(false), refusal: OAuthAuthorizeRefusalSchema }),
]);
export type OAuthAuthorizeValidation = z.infer<typeof OAuthAuthorizeValidationSchema>;

/**
 * `POST /oauth/authorize/decision` — the same raw parameters plus the user's choice. Approving
 * `lazyit.admin` requires the password step-up.
 */
export const OAuthAuthorizeDecisionSchema = z.strictObject({
  params: OAuthAuthorizeParamsSchema,
  decision: z.enum(["approve", "deny"]),
  /** The scopes the user granted — a subset of those requested. Ignored on deny. */
  scopes: z.array(OAuthScopeSchema).default([]),
  password: z.string().min(1).max(1024).optional(),
});
export type OAuthAuthorizeDecision = z.infer<typeof OAuthAuthorizeDecisionSchema>;

/** Where the consent page sends the browser: the client's redirect with a code, or with `access_denied`. */
export const OAuthAuthorizeRedirectSchema = z.object({ redirectTo: z.string().min(1) });
export type OAuthAuthorizeRedirect = z.infer<typeof OAuthAuthorizeRedirectSchema>;
