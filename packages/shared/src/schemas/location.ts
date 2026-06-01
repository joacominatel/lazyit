import { z } from "zod";
import { requireAtLeastOneKey } from "./primitives";

/**
 * Location — where an asset physically lives.
 * Single source of truth for Location validation, shared by `api` (DTOs) and `web`
 * (forms). See docs/02-domain/entities/location.md.
 */

/**
 * Classification of a Location. Hardcoded for now; user-managed custom types are
 * known, deferred debt — see docs/03-decisions/0017-location-type-enum.md.
 * `.options` exposes the values for web dropdowns.
 */
export const LocationTypeSchema = z.enum([
  "OFFICE",
  "DATACENTER",
  "RACK",
  "REMOTE",
  "STORAGE",
  "OTHER",
]);

/**
 * The full Location entity as returned by the API. Date fields are ISO-8601 strings (wire
 * shape) — see the note in user.ts and docs/03-decisions/0018-api-documentation-swagger.md.
 */
export const LocationSchema = z.object({
  id: z.cuid(),
  name: z.string().min(1),
  type: LocationTypeSchema,
  description: z.string().nullable(),
  address: z.string().nullable(),
  // String, not number: floors are labels like "PB", "Subsuelo 1", "Mezzanine".
  floor: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/** Payload to create a Location. `type` is required — every location is classified. */
export const CreateLocationSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  type: LocationTypeSchema,
  description: z.string().trim().min(1).max(2000).optional(),
  address: z.string().trim().min(1).max(500).optional(),
  floor: z.string().trim().min(1).max(50).optional(),
  notes: z.string().trim().min(1).max(2000).optional(),
});

/** Partial update; any subset of the editable fields (an empty body is rejected). */
export const UpdateLocationSchema = requireAtLeastOneKey(
  z
    .strictObject({
      name: z.string().trim().min(1).max(200),
      type: LocationTypeSchema,
      description: z.string().trim().min(1).max(2000),
      address: z.string().trim().min(1).max(500),
      floor: z.string().trim().min(1).max(50),
      notes: z.string().trim().min(1).max(2000),
    })
    .partial(),
);

export type LocationType = z.infer<typeof LocationTypeSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type CreateLocation = z.infer<typeof CreateLocationSchema>;
export type UpdateLocation = z.infer<typeof UpdateLocationSchema>;
