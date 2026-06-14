import { z } from "zod";
import { requireAtLeastOneKey } from "./primitives";

/**
 * User — a person in the organization.
 * Single source of truth for User validation, shared by `api` (DTOs) and `web`
 * (forms). See docs/02-domain/entities/user.md.
 */

/**
 * RBAC role (ADR-0040). A single coarse-grained role on the User — NOT a per-resource ACL matrix
 * (explicitly rejected for the 5–20-person target). Mirrors the Prisma `Role` enum exactly:
 *   - ADMIN  — full access: Access-grant writes, Users administration and destructive deletes.
 *   - MEMBER — normal inventory / KB / asset operations; not Access writes, Users admin or deletes.
 *   - VIEWER — read-only everywhere; cannot mutate anything.
 * Enforcement lives in the API's RolesGuard; this is the shared contract for the wire shape and forms.
 */
export const RoleSchema = z.enum(["ADMIN", "MEMBER", "VIEWER"]);
export type Role = z.infer<typeof RoleSchema>;

/**
 * Where a user's role currently lives, for the auth epic (ADR-0043). Informational only — the API's
 * RolesGuard ALWAYS authorizes from the local DB role (ADR-0043 decision #1); this never gates
 * anything. OPTIONAL and additive so it can be omitted by every current response without breaking
 * existing consumers:
 *   - "local" — the role is managed in lazyit's own DB (current behaviour; the only value emitted today).
 *   - "idp"   — the role is mirrored to / sourced from the IdP (a Phase-2+ concept).
 */
export const RoleSourceSchema = z.enum(["local", "idp"]);
export type RoleSource = z.infer<typeof RoleSourceSchema>;

/**
 * A normalized email for WRITE payloads (ADR-0041). Email is case-insensitive end-to-end: the DB
 * column is `citext` and the live-row unique index is case-insensitive, so input is canonicalized
 * (trim + lowercase) before it is stored. This makes "Bob@x" and "bob@x" the same address on input,
 * matching the citext column, and keeps the stored value tidy. The read `UserSchema.email` stays a
 * plain `z.email()` — the value coming back is already normalized.
 */
export const EmailSchema = z.string().trim().toLowerCase().pipe(z.email());

/**
 * A normalized `legajo` for WRITE payloads (ADR-0058). The employee/file number is stored VERBATIM
 * (lazyit never parses it) but trimmed of surrounding whitespace so " 12345 " and "12345" are the
 * same value against the LIVE-only partial unique index. Bounded so it can't be an unbounded blob.
 */
export const LegajoSchema = z.string().trim().min(1).max(100);

/**
 * A normalized `username` for WRITE payloads (ADR-0058). A directory/display handle — NORMALIZED the
 * same way as email (trim + lowercase) so `Ana` and `ana` collide against the LIVE-only partial unique
 * index. NOT an auth credential and NEVER an account-linking key (that stays email/externalId, INV-2).
 */
export const UsernameSchema = z.string().trim().toLowerCase().min(1).max(100);

/**
 * The TEMPORARY-password policy for admin user-provisioning (ADR-0064, issue #411). It mirrors
 * `SetupPasswordSchema` (the first-run bootstrap wizard's password, `schemas/config.ts`) RULE-FOR-RULE
 * — Zitadel's DEFAULT complexity policy (min 8, max 70, upper + lower + digit + symbol), with the same
 * per-rule messages — so an admin-provisioned temp password is validated identically to the bootstrap
 * one and Zitadel never rejects it mid-mirror (which would leave a half-provisioned, un-loggable user).
 *
 * It is DEFINED HERE rather than imported from `config.ts` ON PURPOSE: `config.ts` already imports
 * `EmailSchema` from THIS module (`config → user`), so importing a schema back (`user → config`) would
 * close a module-import cycle that crashes at evaluation time whenever `user.ts` loads first (the common
 * case — many schemas import `user` directly). Sharing the same DISCIPLINE without the back-import keeps
 * the contract correct and the dependency graph acyclic. If these rules ever change, change both.
 *
 * Like the bootstrap password, this is NEVER persisted to lazyit's DB, NEVER logged (ADR-0031/0064) and
 * NEVER echoed back in a response — it is set on the bundled Zitadel and handed off to the admin once.
 */
export const TempPasswordSchema = z
  .string()
  .min(8, "Must be at least 8 characters long.")
  .max(70, "Must be less than 70 characters long.")
  .regex(/[A-Z]/, "Must include an uppercase letter.")
  .regex(/[a-z]/, "Must include a lowercase letter.")
  .regex(/[0-9]/, "Must include a number.")
  .regex(/[^A-Za-z0-9]/, "Must include a symbol.");
export type TempPassword = z.infer<typeof TempPasswordSchema>;

/**
 * The READ projection of a User's manager (ADR-0058) — a thin, redaction-safe descriptor resolved from
 * the FK, NOT the raw `managerId`/`managerName` columns. A discriminated union over `type`:
 *   - `{ type: "user", … }`     — the manager is a lazyit user. Carries only display fields (id +
 *     firstName + lastName) and `isOffboarded`: TRUE when the linked manager is soft-deleted, so a
 *     report whose manager left surfaces "former manager (offboarded)" rather than a dangle or a leak
 *     of a deleted person's data (decision (b2) / Q2). No email/PII beyond the display name.
 *   - `{ type: "external", name }` — the free-text fallback (`managerName`), when the manager is not a
 *     lazyit user.
 *   - `null`                     — no manager recorded.
 */
export const ManagerDescriptorSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user"),
    id: z.uuid(),
    firstName: z.string(),
    lastName: z.string(),
    // TRUE when the linked manager is soft-deleted (offboarded). The read layer resolves the FK
    // through the soft-delete filter and flags this so the UI shows "former manager (offboarded)".
    isOffboarded: z.boolean(),
  }),
  z.object({
    type: z.literal("external"),
    name: z.string(),
  }),
]);
export type ManagerDescriptor = z.infer<typeof ManagerDescriptorSchema>;

/**
 * The full User entity as returned by the API. Date fields are ISO-8601 strings (the wire
 * shape): the API serializes Prisma `DateTime`s to strings, and `z.date()` cannot be
 * represented in JSON Schema / OpenAPI (see docs/03-decisions/0018-api-documentation-swagger.md).
 */
export const UserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  isActive: z.boolean(),
  // RBAC role (ADR-0040). Always present on the wire; defaults to VIEWER server-side (ADR-0043).
  role: RoleSchema,
  // Where the role is managed (ADR-0043). OPTIONAL + additive: omitted today (implicitly "local"),
  // informational only — the API still authorizes from the DB role, never from this field or a token.
  roleSource: RoleSourceSchema.optional(),
  // IdP `sub` mapping; null until auth is integrated (no auth yet). See ADR-0016.
  externalId: z.string().nullable(),
  // Employee/file number (ADR-0058). Stored verbatim; null when not recorded.
  legajo: z.string().nullable(),
  // Directory/display handle (ADR-0058); null when not recorded.
  username: z.string().nullable(),
  // The resolved manager descriptor (ADR-0058) — NOT the raw managerId/managerName columns. Always
  // present (null = no manager recorded); a soft-deleted linked manager surfaces isOffboarded=true.
  manager: ManagerDescriptorSchema.nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/**
 * The `manager` INPUT union for create/update (ADR-0058) — the wire mirror of the DB CHECK
 * `users_manager_at_most_one`. EITHER a linked lazyit user, OR a free-text name, OR `null` (clear) —
 * never both. A cross-field zod refine (`refineManagerInput`) rejects sending both at once, the same
 * belt-and-suspenders posture as the grant `expiresAt >= grantedAt` refine.
 *   - `{ managerId }`   — link to a lazyit user (uuid).
 *   - `{ managerName }` — the free-text fallback (trimmed, bounded).
 *   - `null`            — clear / no manager.
 * Omitting `manager` entirely leaves it unchanged on update (it's optional on the payload).
 */
export const ManagerInputSchema = z
  .object({
    managerId: z.uuid().optional(),
    managerName: z.string().trim().min(1).max(200).optional(),
  })
  .refine((m) => !(m.managerId !== undefined && m.managerName !== undefined), {
    error:
      "A manager is either a lazyit user (managerId) or a free-text name (managerName), never both.",
  });
export type ManagerInput = z.infer<typeof ManagerInputSchema>;

/**
 * Payload to create a User. A new user is always active (DB default). `externalId` is intentionally
 * NOT accepted from the client: it is the IdP `sub` linkage (ADR-0016), provisioned server-side when
 * auth is integrated. Letting a caller set it would allow pre-linking a local row to a future
 * federated identity (SEC-006). The strictObject rejects it (and any other unknown key).
 *
 * `legajo` / `username` are optional and normalized (ADR-0058). `manager` is the optional input union
 * above (or `null`); omit it for "no manager".
 */
export const CreateUserSchema = z.strictObject({
  // Normalized (trim + lowercase) so the stored value matches the citext column (ADR-0041).
  email: EmailSchema,
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  // RBAC role (ADR-0040; default flipped to VIEWER by ADR-0043). Optional; omitted → server default
  // VIEWER (least-privilege read-only). Accepting it here is SAFE only because the Users controller is
  // ADMIN-gated by the RolesGuard: a non-admin never reaches this endpoint, so they cannot set or
  // escalate a role. Privilege management is an ADMIN-only operation.
  role: RoleSchema.optional(),
  // Employee/file number (ADR-0058). Optional + normalized (trim). Unique among LIVE rows (the partial
  // unique index); a duplicate among live users surfaces as a 409 via the PrismaExceptionFilter.
  legajo: LegajoSchema.optional(),
  // Directory/display handle (ADR-0058). Optional + normalized (trim + lowercase). Same live-unique.
  username: UsernameSchema.optional(),
  // The manager input union (or null). Omit for "no manager". Cross-field refined above.
  manager: ManagerInputSchema.nullable().optional(),
  // The TEMPORARY password an admin may set when provisioning a user (ADR-0064, issue #411). OPTIONAL on
  // the wire — omit it for the unchanged no-credential create. It is HONORED ONLY on the bundled-Zitadel
  // MANAGEMENT path (`idp.supportsManagement`): the API sets it on the freshly-created Zitadel user with
  // `changeRequired:true`, so Zitadel forces a password change at first login — it is a one-time hand-off
  // secret, never a standing admin-known credential. Under BYOI / generic-OIDC the API REJECTS it with a
  // 400 (the operator's own IdP owns the credential). It is NEVER persisted to lazyit's DB, NEVER logged
  // (ADR-0031/0064) and NEVER echoed back in a response. Uses {@link TempPasswordSchema}, which mirrors
  // the bootstrap wizard's `SetupPasswordSchema` discipline rule-for-rule (the same complexity Zitadel
  // enforces) — distinct from the bootstrap carve-out, which sets `changeRequired:false` for the very
  // first admin (this path is always `changeRequired:true`).
  password: TempPasswordSchema.optional(),
});

/**
 * Partial update (an empty body is rejected); `isActive` toggles activation / offboarding. `role`
 * changes a user's RBAC role.
 *
 * Admin user-control (issue #149): `firstName` / `lastName` / `email` are an ADMIN edit of the user's
 * profile, and they are NOT local-only — the API mirrors a name/email change back to the IdP (Zitadel
 * Management API) inside the same no-split-brain transactional + 503-compensation pattern as a role
 * change (ADR-0043 §3, INVARIANTS INV-5): if the Zitadel write fails the local row is reverted and the
 * request is 503. `email` is the account-linking key (citext, INV-2): the write-back updates the
 * EXISTING Zitadel user (same `sub`/`externalId`) and sets the new address pre-verified, so the change
 * never forces re-verification or breaks the account link. `externalId` is intentionally absent here —
 * the strictObject rejects it (SEC-006), so an admin can never re-point a row at a different identity.
 *
 * `legajo` / `username` / `manager` are the ADR-0058 additions: each optional, each cleared by sending
 * `null` (legajo/username) or `manager: null`; `manager` carries the same input union as create.
 */
export const UpdateUserSchema = requireAtLeastOneKey(
  z
    .strictObject({
      // Normalized (trim + lowercase) so the stored value matches the citext column (ADR-0041).
      // Mirrored back to the IdP on change (issue #149): the account-linking key, so the write-back
      // updates the existing Zitadel user (same sub) pre-verified — never a re-link.
      email: EmailSchema,
      // Mirrored back to the IdP profile (givenName / familyName) on change (issue #149).
      firstName: z.string().trim().min(1).max(100),
      lastName: z.string().trim().min(1).max(100),
      isActive: z.boolean(),
      // RBAC role (ADR-0040). Same ADMIN-gated safety as CreateUserSchema: only an ADMIN can reach
      // the Users controller, so a non-admin can never escalate their own (or anyone's) role.
      role: RoleSchema,
      // ADR-0058. `null` clears the value; a string is normalized + checked unique-among-live.
      legajo: LegajoSchema.nullable(),
      username: UsernameSchema.nullable(),
      // The manager input union, or `null` to clear. Cross-field refined (never both id + name).
      manager: ManagerInputSchema.nullable(),
    })
    .partial(),
);

export type User = z.infer<typeof UserSchema>;
export type CreateUser = z.infer<typeof CreateUserSchema>;
export type UpdateUser = z.infer<typeof UpdateUserSchema>;
