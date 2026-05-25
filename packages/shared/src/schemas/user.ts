import { z } from "zod";

/**
 * User — a person in the organization.
 * Single source of truth for User validation, shared by `api` (DTOs) and `web`
 * (forms). See docs/02-domain/entities/user.md.
 */

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
  // IdP `sub` mapping; null until auth is integrated (no auth yet). See ADR-0016.
  externalId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/** Payload to create a User. A new user is always active (DB default). */
export const CreateUserSchema = z.strictObject({
  email: z.email(),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  // Optional: unset today; an IdP-provisioned user may carry its `sub`. See ADR-0016.
  externalId: z.string().min(1).optional(),
});

/** Partial update; `isActive` toggles activation / offboarding. */
export const UpdateUserSchema = z
  .strictObject({
    email: z.email(),
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    isActive: z.boolean(),
  })
  .partial();

export type User = z.infer<typeof UserSchema>;
export type CreateUser = z.infer<typeof CreateUserSchema>;
export type UpdateUser = z.infer<typeof UpdateUserSchema>;
