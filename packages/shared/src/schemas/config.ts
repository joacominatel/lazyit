import { z } from "zod";
import { PasswordPolicySchema } from "./primitives";
import { EmailSchema } from "./user";

/**
 * Config / first-run setup contracts (ADR-0043 Phase 3 — the in-app setup wizard).
 *
 * Single source of truth for the `/config` surface, shared by `api` (DTOs + the ConfigService) and
 * `web` (the setup wizard + the topbar/Users banners). The wizard is driven entirely by these
 * shapes: `GET /config/status` tells the frontend whether the instance is configured (any ADMIN
 * exists), which IdP integration mode is active and whether it is running in a dev posture; the CSRF
 * token gates the one privileged write; `POST /config/setup` creates the first ADMIN.
 *
 * See ADR-0043 §6 (guardrail #3) / Fork #7, as amended by ADR-0102.
 */

/**
 * Which identity posture the instance runs under, derived server-side (ADR-0102):
 *   - "generic-oidc" — BYOI (bring your own OIDC IdP); user/role management is LOCAL-ONLY (no
 *     write-back), so the Users page surfaces the graceful-degradation banner.
 *   - "local"        — first-party local auth (ADR-0086, `AUTH_MODE=local`): NO external IdP at all;
 *     lazyit owns username/email + password directly.
 *
 * The deprecated "zitadel" value was dropped once no web build read it (ADR-0102 §4).
 */
export const IntegrationModeSchema = z.enum(["generic-oidc", "local"]);
export type IntegrationMode = z.infer<typeof IntegrationModeSchema>;

/**
 * `GET /config/status` — `@Public()` first-run detection (ADR-0043 §5a). No secrets. Polled by the
 * `/setup` wizard before any login exists (so it stays public) and by the topbar banner.
 *   - `isConfigured` — true once at least one ADMIN exists (the instance has an administrator and the
 *     wizard self-locks). Derived from `adminCount > 0`, never a stored flag (no migration).
 *   - `adminCount`   — the number of live ADMINs (informational; drives `isConfigured`).
 *   - `integrationMode` — the IdP posture (see {@link IntegrationModeSchema}).
 *   - `devMode`      — true when the server runs a dev posture (AUTH_MODE=shim or NODE_ENV!=production),
 *     so the topbar shows the amber "Dev Mode" banner vs. the blue "Production" one.
 *   - `csrfToken`    — a single-use-style CSRF token the wizard must echo on `POST /config/setup`
 *     (Fork #7). Issued here (and via `GET /config/csrf`) so the public wizard can obtain one without
 *     a session. Stateless (HMAC-signed), never a secret in the security sense.
 */
export const ConfigStatusSchema = z.object({
  isConfigured: z.boolean(),
  adminCount: z.number().int().nonnegative(),
  integrationMode: IntegrationModeSchema,
  devMode: z.boolean(),
  csrfToken: z.string().min(1),
  /**
   * Whether the first-run wizard must collect an initial PASSWORD for the admin. True only in local
   * mode (ADR-0086), where lazyit owns the credential. False for generic OIDC, where the operator
   * already authenticates against their own IdP (trusted-IdP model, ADR-0038/0102). Derived
   * server-side from the auth mode, never a stored flag.
   */
  requiresAdminPassword: z.boolean(),
  /**
   * Whether lazyit can provision IdP accounts for directory persons (the former "Create OIDC account"
   * action, ADR-0069). Always false now that lazyit manages no IdP (ADR-0102 §4); still emitted so an
   * older web build that reads it keeps hiding that action.
   */
  canProvisionAccounts: z.boolean().optional(),
  /**
   * Whether the active mode supports ADMIN-initiated LOCAL onboarding of a directory person — minting a
   * one-time temporary password so an imported, login-less person can sign in (ADR-0086 §5, issue #1072).
   * Derived server-side from `AUTH_MODE=local`: true ONLY in local mode (there is no IdP to mirror to, so
   * lazyit sets the credential directly); undefined/false for generic OIDC, where the operator's IdP
   * manages credentials. The Users page reads this to offer the "Onboard with a temporary password"
   * action. Optional/additive so an older web build ignores it; the backend populates it only in local
   * mode (the OIDC status stays byte-identical).
   */
  canProvisionLocalAccounts: z.boolean().optional(),
  /**
   * The instance-wide authentication mode the UI branches on (ADR-0086) — `"oidc"` (SSO button) vs.
   * `"local"` (username/email + password form). `shim` never reaches a browser (dev X-User-Id header
   * only), so it is NOT part of this UI-facing union.
   *
   * ponytail: OPTIONAL in F1a — the shape exists now so F1c/F2 can consume it, but populating it in
   * `ConfigService.getStatus()` and branching `/login` on it is F2 work (ADR-0086 §6). Keeping it
   * additive-optional here avoids dragging that wiring into the foundation PR.
   */
  authMode: z.enum(["oidc", "local"]).optional(),
});
export type ConfigStatus = z.infer<typeof ConfigStatusSchema>;

/** `GET /config/csrf` — issue a fresh CSRF token without the full status payload. */
export const CsrfTokenSchema = z.object({
  csrfToken: z.string().min(1),
});
export type CsrfToken = z.infer<typeof CsrfTokenSchema>;

/**
 * `POST /config/setup` body (ADR-0043 §5b) — create the FIRST ADMIN. The role is locked to ADMIN by
 * definition (this endpoint exists only to bootstrap the first administrator), so it is NOT accepted
 * from the client. `strictObject` rejects unknown keys (e.g. a smuggled `role`). The CSRF token is
 * carried in the `X-CSRF-Token` header, not the body, mirroring the standard double-submit pattern.
 */
/**
 * Initial-password policy for the first ADMIN in local mode — the SHARED {@link PasswordPolicySchema}
 * (`schemas/primitives.ts`): min 8, max 70, upper + lower + digit + symbol, with the per-rule messages
 * the wizard's live checklist renders 1:1. Using the SAME single definition as the admin temp-password
 * `TempPasswordSchema` (`schemas/user.ts`) means the policies can no longer DRIFT apart (issue #474).
 * NOT used under generic OIDC (the operator's IdP owns the credential — ADR-0038/0102). `.max(70)` is a
 * hard cap before the regex checks.
 */
export const SetupPasswordSchema = PasswordPolicySchema;
export type SetupPassword = z.infer<typeof SetupPasswordSchema>;

export const SetupAdminSchema = z.strictObject({
  // Normalized (trim + lowercase) to match the citext column (ADR-0041), exactly like CreateUserSchema.
  email: EmailSchema,
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  /**
   * Initial password for the first ADMIN. OPTIONAL on the wire: it is REQUIRED only when the server
   * reports `requiresAdminPassword` (local mode) — the API re-checks that posture and 400s a missing
   * password there — and is OMITTED entirely under generic OIDC. See
   * {@link SetupPasswordSchema} and {@link ConfigStatusSchema.requiresAdminPassword}.
   */
  password: SetupPasswordSchema.optional(),
});
export type SetupAdmin = z.infer<typeof SetupAdminSchema>;

/**
 * `POST /config/setup` success result. `mirrored` is always false now that lazyit writes nothing back
 * to an IdP (ADR-0102 §4); it stays on the wire so an older web build reading it keeps working.
 */
export const SetupResultSchema = z.object({
  success: z.literal(true),
  adminId: z.uuid(),
  email: z.email(),
  /** Always false (ADR-0102 §4). */
  mirrored: z.boolean(),
  setupCompletedAt: z.iso.datetime(),
});
export type SetupResult = z.infer<typeof SetupResultSchema>;
