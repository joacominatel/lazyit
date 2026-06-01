import { z } from "zod";
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
 * See docs/01-architecture/auth-zitadel-sot.md §5/§7 and ADR-0043 §6 (guardrail #3) / Fork #7.
 */

/**
 * Which IdP management posture the instance runs under (ADR-0043), derived server-side from
 * `IDENTITY_PROVIDER_TYPE`:
 *   - "zitadel"      — the bundled, lazyit-managed IdP; user/role write-back is possible.
 *   - "generic-oidc" — BYOI (bring your own OIDC IdP); user/role management is LOCAL-ONLY (no
 *     write-back), so the Users page surfaces the graceful-degradation banner.
 * Mirrors `IdentityProviderType` in the API's identity-provider factory (one definition each side).
 */
export const IntegrationModeSchema = z.enum(["zitadel", "generic-oidc"]);
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
export const SetupAdminSchema = z.strictObject({
  // Normalized (trim + lowercase) to match the citext column (ADR-0041), exactly like CreateUserSchema.
  email: EmailSchema,
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
});
export type SetupAdmin = z.infer<typeof SetupAdminSchema>;

/**
 * `POST /config/setup` success result. `mirrored` reports whether the new ADMIN was also mirrored
 * into the IdP (true only for zitadel + a configured Management credential); when a Management call
 * failed, setup still succeeds local-only (`mirrored: false`) — first-run bootstrap is never
 * hard-blocked by an IdP misconfiguration (ADR-0043 §6 #4 / the task degrade-not-block rule).
 */
export const SetupResultSchema = z.object({
  success: z.literal(true),
  adminId: z.uuid(),
  email: z.email(),
  /** Whether the ADMIN was mirrored into the IdP (false = created local-only). */
  mirrored: z.boolean(),
  setupCompletedAt: z.iso.datetime(),
});
export type SetupResult = z.infer<typeof SetupResultSchema>;
