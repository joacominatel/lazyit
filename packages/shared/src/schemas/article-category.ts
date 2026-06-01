import { z } from "zod";
import { int4, requireAtLeastOneKey } from "./primitives";

/**
 * ArticleCategory — user-managed grouping for knowledge-base Articles (Networking, Servers,
 * Procedures, …). Created, edited and soft-deleted from the app, like AssetCategory. Single source
 * of truth for both api and web. See docs/02-domain/entities/article-category.md.
 *
 * Date fields are ISO-8601 strings (the wire shape): the API serializes Prisma `DateTime`s to
 * strings, and `z.date()` cannot be represented in JSON Schema / OpenAPI ([[0018]]).
 */

/** The full persisted ArticleCategory entity (API representation of the `article_categories` row). */
export const ArticleCategorySchema = z.object({
  id: z.cuid(),
  name: z.string().min(1),
  description: z.string().nullable(),
  // Free string: a heroicon name for the web UI (e.g. "ServerStackIcon"). Not validated.
  icon: z.string().nullable(),
  // Optional sort key for the sidebar/listings (lower first); null sorts last.
  order: int4().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/** Payload to create an ArticleCategory. `name` is unique (enforced by the DB). */
export const CreateArticleCategorySchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1000).optional(),
  icon: z.string().trim().min(1).max(100).optional(),
  order: int4({ example: 0 }).optional(),
});

/** Partial update; any subset of the editable fields (an empty body is rejected). */
export const UpdateArticleCategorySchema = requireAtLeastOneKey(
  z
    .strictObject({
      name: z.string().trim().min(1).max(100),
      description: z.string().trim().min(1).max(1000),
      icon: z.string().trim().min(1).max(100),
      order: int4({ example: 0 }),
    })
    .partial(),
);

export type ArticleCategory = z.infer<typeof ArticleCategorySchema>;
export type CreateArticleCategory = z.infer<typeof CreateArticleCategorySchema>;
export type UpdateArticleCategory = z.infer<typeof UpdateArticleCategorySchema>;
