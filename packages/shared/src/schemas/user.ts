import { z } from "zod";

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
 * A normalized email for WRITE payloads (ADR-0041). Email is case-insensitive end-to-end: the DB
 * column is `citext` and the live-row unique index is case-insensitive, so input is canonicalized
 * (trim + lowercase) before it is stored. This makes "Bob@x" and "bob@x" the same address on input,
 * matching the citext column, and keeps the stored value tidy. The read `UserSchema.email` stays a
 * plain `z.email()` — the value coming back is already normalized.
 */
export const EmailSchema = z.string().trim().toLowerCase().pipe(z.email());

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
  // RBAC role (ADR-0040). Always present on the wire; defaults to MEMBER server-side.
  role: RoleSchema,
  // IdP `sub` mapping; null until auth is integrated (no auth yet). See ADR-0016.
  externalId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/**
 * Payload to create a User. A new user is always active (DB default). `externalId` is intentionally
 * NOT accepted from the client: it is the IdP `sub` linkage (ADR-0016), provisioned server-side when
 * auth is integrated. Letting a caller set it would allow pre-linking a local row to a future
 * federated identity (SEC-006). The strictObject rejects it (and any other unknown key).
 */
export const CreateUserSchema = z.strictObject({
  // Normalized (trim + lowercase) so the stored value matches the citext column (ADR-0041).
  email: EmailSchema,
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  // RBAC role (ADR-0040). Optional; omitted → server default MEMBER. Accepting it here is SAFE only
  // because the Users controller is ADMIN-gated by the RolesGuard: a non-admin never reaches this
  // endpoint, so they cannot set or escalate a role. Privilege management is an ADMIN-only operation.
  role: RoleSchema.optional(),
});

/** Partial update; `isActive` toggles activation / offboarding. `role` changes a user's RBAC role. */
export const UpdateUserSchema = z
  .strictObject({
    // Normalized (trim + lowercase) so the stored value matches the citext column (ADR-0041).
    email: EmailSchema,
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    isActive: z.boolean(),
    // RBAC role (ADR-0040). Same ADMIN-gated safety as CreateUserSchema: only an ADMIN can reach the
    // Users controller, so a non-admin can never escalate their own (or anyone's) role.
    role: RoleSchema,
  })
  .partial();

export type User = z.infer<typeof UserSchema>;
export type CreateUser = z.infer<typeof CreateUserSchema>;
export type UpdateUser = z.infer<typeof UpdateUserSchema>;
