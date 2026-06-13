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
  // Self-ref parent folder (ADR-0059 §1): null = a ROOT folder. The flat category became the root
  // level of a tree. The model/table stay ArticleCategory / `article_categories` (the rename to
  // Folder is a follow-up); only the tree column is added. See docs/02-domain/entities/folder.md.
  parentId: z.cuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/**
 * Payload to create an ArticleCategory. `name` is unique PER PARENT among live rows (a partial
 * unique index — ADR-0059 §1). `parentId` is optional: omitted → a root folder; a cuid nests this
 * folder under another. A non-existent or soft-deleted parent is rejected by the service.
 */
export const CreateArticleCategorySchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(1000).optional(),
  icon: z.string().trim().min(1).max(100).optional(),
  order: int4({ example: 0 }).optional(),
  // Optional parent folder (ADR-0059 §1). Absent = a root folder.
  parentId: z.cuid().optional(),
});

/**
 * Partial update; any subset of the editable fields (an empty body is rejected). `parentId` is
 * nullable here (unlike create): pass `null` to MOVE this folder to the root, or a cuid to reparent
 * it. The service rejects a move that would create a cycle (a folder may not be its own ancestor).
 */
export const UpdateArticleCategorySchema = requireAtLeastOneKey(
  z
    .strictObject({
      name: z.string().trim().min(1).max(100),
      description: z.string().trim().min(1).max(1000),
      icon: z.string().trim().min(1).max(100),
      order: int4({ example: 0 }),
      parentId: z.cuid().nullable(),
    })
    .partial(),
);

export type ArticleCategory = z.infer<typeof ArticleCategorySchema>;
export type CreateArticleCategory = z.infer<typeof CreateArticleCategorySchema>;
export type UpdateArticleCategory = z.infer<typeof UpdateArticleCategorySchema>;
