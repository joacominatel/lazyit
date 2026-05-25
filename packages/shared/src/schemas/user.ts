import { z } from "zod";

/**
 * User — a person in the organization.
 * Single source of truth for User validation, shared by `api` (DTOs) and `web`
 * (forms). See docs/02-domain/entities/user.md.
 */

/** The full persisted User entity (mirrors the Prisma `users` row). */
export const UserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  isActive: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullable(),
});

/** Payload to create a User. A new user is always active (DB default). */
export const CreateUserSchema = z.strictObject({
  email: z.email(),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
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
