import { z } from "zod";

/**
 * ArticleAlias — a nav-only "symlink" that makes one Article appear inside a Folder other than its
 * home, without moving its home or widening its access (ADR-0059 §2). Single source of truth for api
 * and web. See docs/02-domain/entities/article-alias.md.
 *
 * Date fields are ISO-8601 strings (the wire shape). An alias is current-state — created (POST) or
 * removed (hard DELETE), never edited — so there is no Update payload schema. The MVP carries NO
 * access-granting column: an alias is presentation only and can never widen access (ADR-0060 owns
 * any future alias-as-share).
 */

/** A single ArticleAlias row (API representation of the `article_aliases` row). */
export const ArticleAliasSchema = z.object({
  id: z.cuid(),
  // The folder this alias places the article into (NOT the article's home folder).
  folderId: z.cuid(),
  articleId: z.cuid(),
  createdAt: z.iso.datetime(),
});

/**
 * Payload to create an alias (`POST /articles/:id/aliases`). The articleId comes from the route,
 * never the body. The target `folderId` must be a live folder and must NOT equal the article's home
 * folder (you cannot alias an article into its own home — rejected by the service); a duplicate
 * `(folderId, articleId)` is rejected by the DB unique index (409).
 */
export const CreateArticleAliasSchema = z.strictObject({
  folderId: z.cuid(),
});

export type ArticleAlias = z.infer<typeof ArticleAliasSchema>;
export type CreateArticleAlias = z.infer<typeof CreateArticleAliasSchema>;
