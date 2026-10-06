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
  // Live-article count for this folder (#1106 Phase 4). A COMPUTED read aggregate (Prisma `_count`
  // over the articles relation), NOT a stored column — no migration, no data touch. Counts only the
  // articles the CALLER could actually browse in the list (ADR-0060 §4 folder access + the article
  // list's PUBLISHED-or-own-DRAFT visibility), so it never reveals more than the list would show. The
  // api sends `null` for a folder the caller cannot read (its count would leak hidden articles) and a
  // legacy/older server omits the field entirely — `.nullish()` accepts both, and the UI hides the
  // number when it is null/absent (self-heals on any operator upgrade without a client change).
  articleCount: int4({ min: 0, example: 0 }).nullish(),
  // Derived "this folder carries an access rule" flag (ADR-0060 §3 carve-out, #1299). A COMPUTED read
  // aggregate over the `accessRules` jsonb — NOT a stored column, no migration, no data touch. It is
  // the SAME public-vs-restricted question `isPublicAccessRules` answers (`null`/empty = PUBLIC, a
  // non-empty rule list = restricted), inverted: `true` means the folder has a restriction.
  //
  // It says a restriction EXISTS; it says NOTHING about the reader. It is not "you cannot see this"
  // (a caller who reads the folder normally sees `true` for a folder they are allowed into), and it
  // never carries the rule CONTENT — not the kinds, not the user list, not the role, not counts. The
  // rules themselves (`accessRules`) stay gated to `settings:manage` (#554); this flag is readable by
  // any `category:read` caller, VIEWER included, so the web UI can warn that moving an article into or
  // out of a restricted folder changes who may read it (ADR-0060 §9).
  //
  // `.optional()`: a server that predates the field omits it entirely, and a client that predates it
  // ignores it — the field self-heals on an operator upgrade with no client change. Absent means
  // "unknown", never "public": treat only an explicit `true`/`false` as an answer.
  hasAccessRules: z.boolean().optional(),
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
