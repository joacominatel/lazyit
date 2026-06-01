import { z } from "zod";

/**
 * ArticleLink — associates an Article with EITHER an Asset OR an Application ("the runbook for THIS
 * server / this app"), making the KB IT-native (ADR-0042). Exactly one target is set; this is the
 * single source of truth for api and web. See docs/02-domain/entities/article-link.md.
 *
 * Date fields are ISO-8601 strings (the wire shape). A link is current-state — created or removed
 * (hard delete), never edited — so there is no Update payload schema.
 */

/** A single ArticleLink row (API representation of the `article_links` row). */
export const ArticleLinkSchema = z.object({
  id: z.cuid(),
  articleId: z.cuid(),
  assetId: z.cuid().nullable(),
  applicationId: z.cuid().nullable(),
  createdById: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

/**
 * Payload to create a link (`POST /articles/:id/links`). The articleId comes from the route, never
 * the body; `createdById` comes from the caller (X-User-Id). Exactly one of `assetId` /
 * `applicationId` must be set — a `.refine` enforces the XOR at the edge (the DB also has a CHECK
 * constraint as the hard guarantee — ADR-0042).
 */
export const CreateArticleLinkSchema = z
  .strictObject({
    assetId: z.cuid().optional(),
    applicationId: z.cuid().optional(),
  })
  .refine(
    (v) => (v.assetId === undefined) !== (v.applicationId === undefined),
    {
      message:
        "Exactly one of assetId or applicationId must be set (an ArticleLink targets an Asset XOR an Application)",
    },
  );

export type ArticleLink = z.infer<typeof ArticleLinkSchema>;
export type CreateArticleLink = z.infer<typeof CreateArticleLinkSchema>;
