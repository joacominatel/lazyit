import { z } from "zod";

/**
 * ApplicationCategory — user-managed grouping for Applications (SaaS, Internal, Service, …).
 * Created, edited and soft-deleted from the app, like AssetCategory / ArticleCategory. Single
 * source of truth for both api and web. See docs/02-domain/entities/application-category.md and
 * docs/03-decisions/0023-access-management-design.md.
 *
 * Date fields are ISO-8601 strings (the wire shape): the API serializes Prisma `DateTime`s to
 * strings, and `z.date()` cannot be represented in JSON Schema / OpenAPI ([[0018]]).
 */

/** The full persisted ApplicationCategory entity (API representation of `application_categories`). */
export const ApplicationCategorySchema = z.object({
  id: z.cuid(),
  name: z.string().min(1),
  description: z.string().nullable(),
  // Free string: a heroicon name for the web UI (e.g. "CloudIcon"). Not validated.
  icon: z.string().nullable(),
  // Optional sort key for the listing (lower first); null sorts last.
  order: z.number().int().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/** Payload to create an ApplicationCategory. `name` is unique (enforced by the DB). */
export const CreateApplicationCategorySchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1000).optional(),
  icon: z.string().trim().min(1).max(100).optional(),
  order: z.number().int().optional(),
});

/** Partial update; any subset of the editable fields. */
export const UpdateApplicationCategorySchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(1000),
    icon: z.string().trim().min(1).max(100),
    order: z.number().int(),
  })
  .partial();

export type ApplicationCategory = z.infer<typeof ApplicationCategorySchema>;
export type CreateApplicationCategory = z.infer<
  typeof CreateApplicationCategorySchema
>;
export type UpdateApplicationCategory = z.infer<
  typeof UpdateApplicationCategorySchema
>;
