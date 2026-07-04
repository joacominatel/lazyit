import { z } from "zod";
import { optionalText, requireAtLeastOneKey } from "./primitives";

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
  // Self-referential hierarchy (adjacency list, #845). NULL = a root location. Cheap to expose
  // on list rows — it's a plain column, no extra query. Cycle-free is enforced server-side.
  parentId: z.cuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/**
 * A single hop in a Location breadcrumb — the minimal fields the web breadcrumb renders. Used by
 * {@link LocationDetailSchema}'s `path`.
 */
export const LocationBreadcrumbSchema = z.object({
  id: z.cuid(),
  name: z.string().min(1),
  type: LocationTypeSchema,
});

/**
 * The Location detail shape returned by `GET /locations/:id` — the full entity PLUS a resolved
 * ancestry `path`, ordered root→self INCLUSIVE (the last element is the location itself), so the web
 * breadcrumb renders it directly. The list endpoint returns plain {@link LocationSchema} rows
 * (parentId only, no `path`) to avoid an N+1 ancestry walk per row. (#845)
 */
export const LocationDetailSchema = LocationSchema.extend({
  path: z.array(LocationBreadcrumbSchema),
});

/**
 * Payload to create a Location. `type` is required — every location is classified. `parentId`
 * (optional) hangs this location under another; the service rejects a missing/soft-deleted parent
 * (400). Omit or pass `null` for a root. (#845)
 */
export const CreateLocationSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  type: LocationTypeSchema,
  description: z.string().trim().min(1).max(2000).optional(),
  address: z.string().trim().min(1).max(500).optional(),
  floor: z.string().trim().min(1).max(50).optional(),
  notes: optionalText(2000),
  parentId: z.cuid().nullish(),
});

/**
 * Partial update; any subset of the editable fields (an empty body is rejected). Setting `parentId`
 * re-parents (service rejects a cycle — self or a descendant — and a missing/soft-deleted parent,
 * all 400); pass `null` to promote the location to a root. (#845)
 */
export const UpdateLocationSchema = requireAtLeastOneKey(
  z
    .strictObject({
      name: z.string().trim().min(1).max(200),
      type: LocationTypeSchema,
      description: z.string().trim().min(1).max(2000),
      address: z.string().trim().min(1).max(500),
      floor: z.string().trim().min(1).max(50),
      notes: z.string().trim().min(1).max(2000),
      parentId: z.cuid().nullable(),
    })
    .partial(),
);

export type LocationType = z.infer<typeof LocationTypeSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type LocationBreadcrumb = z.infer<typeof LocationBreadcrumbSchema>;
export type LocationDetail = z.infer<typeof LocationDetailSchema>;
export type CreateLocation = z.infer<typeof CreateLocationSchema>;
export type UpdateLocation = z.infer<typeof UpdateLocationSchema>;
