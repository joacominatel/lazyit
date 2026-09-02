import { z } from "zod";
import { PASSWORD_MAX_LENGTH } from "../constants/local-auth";
import { RoleSchema } from "./user";

/**
 * Local-mode login wire contract — ADR-0086 §3, AUTH_MODE=local. Shared so the API's `POST /auth/login`
 * DTO and the web Credentials provider (F2) validate ONE definition.
 */

/**
 * The login request body. `identifier` is an email OR a username (the server resolves either against the
 * LIVE-filtered user table). Both are normalized (trim + lowercase) server-side before lookup — email is
 * citext and username is stored lowercased, so a single lowercase lookup matches either. `password` is
 * bounded by {@link PASSWORD_MAX_LENGTH} so an oversized body is rejected (400) BEFORE argon2 runs.
 */
export const LoginRequestSchema = z.object({
  identifier: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/**
 * The SAFE user projection returned on a successful login — only non-sensitive display/identity fields.
 * NEVER carries `passwordHash`, `sessionEpoch`, or anything authorization-bearing (the role here is
 * informational for the UI; the API always re-resolves authorization DB-first per request, INV-1).
 */
export const LoginUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  firstName: z.string(),
  lastName: z.string(),
  username: z.string().nullable(),
  role: RoleSchema,
});
export type LoginUser = z.infer<typeof LoginUserSchema>;

/**
 * The login response: the first-party session token (HS256 JWT) to present as a Bearer on later requests,
 * plus the safe user projection. The token carries only `sub` + `sessionEpoch` — no role/permissions.
 */
export const LoginResponseSchema = z.object({
  token: z.string().min(1),
  user: LoginUserSchema,
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/**
 * `POST /users/:id/reset-password` result IN LOCAL MODE (AUTH_MODE=local, ADR-0086 §5). An admin reset
 * mints a one-time temporary password locally (there is no IdP to email a link, and no instance SMTP
 * yet), sets `mustChangePassword`, bumps the subject's `sessionEpoch` (killing their existing sessions)
 * and audits `PASSWORD_RESET_BY_ADMIN`. The plaintext is returned to the admin to hand off ONCE — it is
 * never stored in plaintext or shown again. In OIDC mode the endpoint keeps its 204 No Content shape
 * (Zitadel emails the link), so this body is local-mode only.
 */
export const AdminPasswordResetResultSchema = z.object({
  temporaryPassword: z.string().min(1),
});
export type AdminPasswordResetResult = z.infer<
  typeof AdminPasswordResetResultSchema
>;

/**
 * How an admin-initiated password reset reaches the subject IN LOCAL MODE (ADR-0086 §5, amended by
 * issue #1268). The admin picks explicitly rather than the server guessing, because the two modes have
 * genuinely different operational meaning:
 *   - `email` — mint a single-use, short-TTL reset link and send it through the INSTANCE SMTP
 *     ([[0079-instance-smtp-outbound-email]]). The subject sets their own password; lazyit never sees it.
 *   - `temporary-password` — the original F1c behavior: mint a one-time password, hash it, and hand the
 *     plaintext back to the admin ONCE. The escape hatch for a subject who cannot reach their mailbox
 *     (no SMTP, wrong address, locked out of email), so it must stay available even when email works.
 */
export const AdminPasswordResetDeliverySchema = z.enum([
  "email",
  "temporary-password",
]);
export type AdminPasswordResetDelivery = z.infer<
  typeof AdminPasswordResetDeliverySchema
>;

/**
 * `POST /users/:id/reset-password` request body — OPTIONAL, and omitting it must keep the pre-#1268
 * behavior byte-identical (OIDC: ask the IdP, 204; local: mint a temp password, 200). That back-compat is
 * not decoration: an operator who updates the API before the web build must not get a broken Users page
 * (upgrade-safety, CLAUDE.md §8).
 *
 * `revokeSessions` applies to the `email` delivery ONLY, and defaults to FALSE. Sending a link does not
 * change the stored credential, so the subject's live sessions are still legitimately theirs — killing
 * them is a deliberate "I think this account is compromised" act, not the default. The
 * `temporary-password` delivery ignores this field and ALWAYS revokes: it overwrites `passwordHash` on the
 * spot, so a surviving session would be holding a credential that no longer exists.
 */
export const AdminPasswordResetRequestSchema = z.object({
  delivery: AdminPasswordResetDeliverySchema,
  revokeSessions: z.boolean().optional(),
});
export type AdminPasswordResetRequest = z.infer<
  typeof AdminPasswordResetRequestSchema
>;

/**
 * The `email` outcome. Reported HONESTLY — unlike the public `POST /auth/forgot-password`, which is
 * uniform-by-design so it cannot be used as an account-enumeration oracle. Here the caller is an
 * authenticated admin who already knows the account exists, so a silent no-op would only deceive the one
 * person who needs the truth. A missing SMTP config or an unresolvable link origin is a 409 and a send
 * failure is a 503 — never a cheerful 200.
 */
export const AdminPasswordResetEmailOutcomeSchema = z.object({
  delivery: z.literal("email"),
  /** The address the link actually went to — echoed so the admin can spot a stale/wrong mailbox. */
  sentTo: z.email(),
  /** Link lifetime, so the UI can tell the subject how long they have without hardcoding the TTL. */
  expiresInMinutes: z.number().int().positive(),
  /** Whether the subject's live sessions were killed (the opt-in `revokeSessions`). */
  sessionsRevoked: z.boolean(),
});

/**
 * The `temporary-password` outcome. A SUPERSET of {@link AdminPasswordResetResultSchema}: the plaintext
 * still arrives under `temporaryPassword`, so a pre-#1268 web build that reads only that field keeps
 * working against a newer API.
 */
export const AdminPasswordResetTemporaryOutcomeSchema = z.object({
  delivery: z.literal("temporary-password"),
  /** Shown ONCE — never stored in plaintext, never refetchable. */
  temporaryPassword: z.string().min(1),
  /** Always true here: the stored hash was just replaced, so surviving sessions would be stale. */
  sessionsRevoked: z.literal(true),
});

/** The local-mode result of `POST /users/:id/reset-password`, discriminated on `delivery`. */
export const AdminPasswordResetOutcomeSchema = z.discriminatedUnion("delivery", [
  AdminPasswordResetEmailOutcomeSchema,
  AdminPasswordResetTemporaryOutcomeSchema,
]);
export type AdminPasswordResetOutcome = z.infer<
  typeof AdminPasswordResetOutcomeSchema
>;

/**
 * Why the `email` delivery is unavailable, when it is. Two distinct operator fixes, so they are two
 * distinct values rather than one vague "unavailable":
 *   - `smtp-not-configured` — Settings → Instance → SMTP is off or incomplete (host/port/from).
 *   - `origin-unknown` — no `WEB_ORIGIN` and no trustworthy request origin to build the link against, so
 *     any link we produced would point nowhere. Reachable on a host-agnostic LAN deploy ([[0087]]).
 */
export const PasswordResetEmailUnavailableReasonSchema = z.enum([
  "smtp-not-configured",
  "origin-unknown",
]);
export type PasswordResetEmailUnavailableReason = z.infer<
  typeof PasswordResetEmailUnavailableReasonSchema
>;

/**
 * `GET /users/password-reset-capabilities` (authenticated, `user:manage`) — what the reset dialog may
 * offer, resolved server-side.
 *
 * This deliberately does NOT live on `GET /config/status`, which is `@Public`: whether an instance has
 * working outbound email is operational detail an anonymous visitor has no business reading. Gating it
 * behind the same permission that owns the action keeps the disclosure proportional.
 */
export const PasswordResetCapabilitiesSchema = z.object({
  /** True in `AUTH_MODE=local` — the only mode where lazyit itself owns the credential. */
  canResetLocally: z.boolean(),
  /** True when a reset link can actually be built AND sent right now. */
  canEmailResetLink: z.boolean(),
  /** True in local mode; the always-available fallback when the subject cannot reach their mailbox. */
  canMintTemporaryPassword: z.boolean(),
  /** Present only when `canEmailResetLink` is false in local mode — tells the admin what to go fix. */
  emailUnavailableReason: PasswordResetEmailUnavailableReasonSchema.optional(),
});
export type PasswordResetCapabilities = z.infer<
  typeof PasswordResetCapabilitiesSchema
>;
