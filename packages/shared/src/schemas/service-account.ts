import { z } from "zod";
import { requireAtLeastOneKey } from "./primitives";
import { PermissionSchema } from "./permission";

/**
 * ServiceAccount — a NON-HUMAN principal (ADR-0048). A CI runner, a script, an integration: something
 * that calls the lazyit API without a person behind it. It is deliberately a SEPARATE entity from
 * `User` (not a `type` flag, not a Zitadel machine-user), so the human table — JIT provisioning, the
 * last-admin / first-admin invariants, `externalId` linkage — stays completely untouched.
 *
 * AUTH (ADR-0048): a service account authenticates with a LAZYIT-NATIVE token (BYOI-safe — no IdP
 * dependency), wire format `lzit_sa_<serviceAccountId>_<secret>`. The secret is high-entropy
 * (`crypto.randomBytes(32)` base64url) so the server stores only its SHA-256 `tokenHash` (+ a short
 * `tokenPrefix` for display) and compares in constant time. The full token is shown EXACTLY ONCE on
 * create / rotate and is never recoverable.
 *
 * AUTHZ (ADR-0048): a service account is authorized by DIRECT permission grants from the SAME frozen
 * `@lazyit/shared` Permission catalog humans use — NEVER a `Role`, NEVER ADMIN-equivalent. It is
 * FAIL-CLOSED: it passes only `@Public` routes and routes whose `@RequirePermission(...)` it fully
 * holds (it does NOT inherit the human open-by-default for unannotated routes — INV-SA-2).
 *
 * Single source of truth for ServiceAccount validation, shared by `api` (DTOs / token parsing) and a
 * future `web` admin UI. See docs/03-decisions/0048-service-accounts.md and docs/06-security/INVARIANTS.md.
 */

/**
 * The wire prefix every lazyit-native service-account token starts with. The full token format is
 * `lzit_sa_<serviceAccountId>_<secret>`: a stable, greppable marker the auth guard matches on BEFORE
 * the OIDC branch, plus the account id (so the server can look the row up without a table scan) and the
 * opaque secret. Exported so the api guard and the (future) web UI agree on the exact literal.
 */
export const SERVICE_ACCOUNT_TOKEN_PREFIX = "lzit_sa_" as const;

/**
 * A non-empty, deduplicated array of catalog `Permission` literals for a service account's direct
 * grants. Every entry is validated against the FROZEN `@lazyit/shared` catalog (`PermissionSchema`),
 * so an unknown literal → 400 and a service account can never be granted a capability the code does
 * not know about. `.min(1)`: a service account with NO permissions could authenticate but pass nothing
 * (fail-closed) — almost always a mistake, so we reject it at the edge rather than mint a useless token.
 * Duplicates are squashed so the persisted grant set and any audit diff are computed against a clean set.
 */
const ServiceAccountPermissionsSchema = z
  .array(PermissionSchema)
  .min(1, "A service account must be granted at least one permission")
  .transform((perms) => [...new Set(perms)]);

/**
 * The full ServiceAccount entity as returned by the API (the management list / detail reads). Date
 * fields are ISO-8601 strings (the wire shape; `z.date()` cannot be represented in OpenAPI — ADR-0018).
 *
 * SECURITY: this NEVER carries the secret or the `tokenHash`. Only `tokenPrefix` — a short, non-secret
 * display fragment of the token (e.g. `lzit_sa_abc…`) — is exposed so an operator can recognise which
 * credential a row corresponds to without revealing anything usable.
 */
export const ServiceAccountSchema = z.object({
  id: z.cuid(),
  name: z.string().min(1),
  description: z.string().nullable(),
  // A short, non-secret display fragment of the token (NOT the secret). For UI recognition only.
  tokenPrefix: z.string().min(1),
  isActive: z.boolean(),
  // Optional expiry (ADR-0048): a token presented after this instant is rejected (401). null = no expiry.
  expiresAt: z.iso.datetime().nullable(),
  // Set on each successful authentication (best-effort, fire-and-forget). null until first use.
  lastUsedAt: z.iso.datetime().nullable(),
  // The direct permission grants this service account holds (catalog literals). Authorization is by
  // THIS set, never a role.
  permissions: z.array(PermissionSchema),
  // System-managed (engine-owned) flag (issue #304). `true` for the auto-provisioned, reserved-name
  // singleton a workflow run EXECUTES AS (the `lazyit-workflow-engine` SA, ADR-0048/ADR-0054 §6): the
  // server REJECTS editing/disabling/rotating/revoking it (it must always exist as the run actor) and
  // the admin UI gates its row controls off THIS signal — never a hardcoded name on the client. `false`
  // for every operator-created account. Defaults to `false` so a pre-flag payload still parses.
  systemManaged: z.boolean().default(false),
  // The human (User.id) who created it; null if that user was later deleted (FK SetNull).
  createdById: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});
export type ServiceAccount = z.infer<typeof ServiceAccountSchema>;

/**
 * Payload to create a service account (ADR-0048). `name` + `permissions[]` only — there is NO token
 * field: the secret is MINTED server-side (`crypto.randomBytes`) and returned exactly once, never
 * accepted from the client. `expiresAt` is an optional future instant (no forced expiry in v1). The
 * `strictObject` rejects any unknown key (e.g. a client-supplied `tokenHash`, `isActive` or `id`).
 */
export const CreateServiceAccountSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  permissions: ServiceAccountPermissionsSchema,
  // Optional expiry. ISO-8601 on the wire; the API rejects a past instant. Omitted → no expiry.
  expiresAt: z.iso.datetime().optional(),
});
export type CreateServiceAccount = z.infer<typeof CreateServiceAccountSchema>;

/**
 * Partial update (an empty body is rejected — ADR-0048). Renames, edits the description, replaces the
 * permission set wholesale, toggles `isActive` (a soft disable distinct from revoke/delete), or changes
 * `expiresAt`. `expiresAt` is NULLABLE here so an operator can clear an expiry (`{ expiresAt: null }`);
 * `description` is likewise nullable to clear it. The token/secret are NEVER editable here (rotate is a
 * dedicated endpoint). The `strictObject` rejects any unknown key (`tokenHash`, `createdById`, …).
 */
export const UpdateServiceAccountSchema = requireAtLeastOneKey(
  z
    .strictObject({
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(500).nullable(),
      permissions: ServiceAccountPermissionsSchema,
      isActive: z.boolean(),
      expiresAt: z.iso.datetime().nullable(),
    })
    .partial(),
);
export type UpdateServiceAccount = z.infer<typeof UpdateServiceAccountSchema>;

/**
 * The ONCE-ONLY response of create / rotate (ADR-0048): the full ServiceAccount entity PLUS the
 * cleartext `token` (`lzit_sa_<id>_<secret>`). This is the only place the secret ever appears on the
 * wire — the caller must store it now, because it is never persisted in cleartext and never returned
 * again. Every other read returns the plain {@link ServiceAccountSchema} (no token).
 */
export const ServiceAccountWithSecretSchema = ServiceAccountSchema.extend({
  // The cleartext token, shown exactly once. Stored server-side only as a SHA-256 hash.
  token: z.string().min(1),
});
export type ServiceAccountWithSecret = z.infer<
  typeof ServiceAccountWithSecretSchema
>;
