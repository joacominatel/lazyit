import { z } from "zod";
import { int4 } from "./primitives";
import { ArticleStatusSchema } from "./article";
import { pageSchema } from "./pagination";

/**
 * ArticleVersion — an append-only snapshot of an Article's editable state, written on every
 * create/edit that changes title/content/excerpt/status (ADR-0042). Restores the auditability
 * principle (ADR-0006): editing an article no longer destroys the prior body. Single source of
 * truth for api and web. See docs/02-domain/entities/article-version.md.
 *
 * Date fields are ISO-8601 strings (the wire shape). `id` is a numeric autoincrement (a log id);
 * the externally meaningful key is `(articleId, version)`. Versions are never edited or deleted, so
 * there is no Create/Update payload schema — snapshots are produced internally by the service.
 */

/** A single ArticleVersion row (API representation of the `article_versions` row). */
export const ArticleVersionSchema = z.object({
  id: int4({ min: 1 }),
  articleId: z.cuid(),
  // 1 on create, then 2, 3, … — monotonic per article.
  version: int4({ min: 1 }),
  title: z.string().min(1),
  content: z.string(),
  excerpt: z.string().nullable(),
  status: ArticleStatusSchema,
  editedById: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

/**
 * The paginated `GET /articles/:id/versions` envelope: `{ items: ArticleVersion[], total, limit,
 * offset }` (ADR-0030). Newest version first.
 */
export const ArticleVersionPageSchema = pageSchema(ArticleVersionSchema);

export type ArticleVersion = z.infer<typeof ArticleVersionSchema>;
export type ArticleVersionPage = z.infer<typeof ArticleVersionPageSchema>;
