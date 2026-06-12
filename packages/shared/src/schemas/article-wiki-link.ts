import { z } from "zod";

/**
 * ArticleWikiLink — a materialized article↔article edge, one row per `[[slug]]` reference found in a
 * source Article's body (ADR-0059 §3/§4). Powers backlinks ("References") and fast link resolution.
 * Single source of truth for api and web. See docs/02-domain/entities/article-wiki-link.md.
 *
 * Distinct from ArticleLink (article↔asset/application — ADR-0042). A wiki-link is a DERIVED
 * projection: hard-rebuilt on every content-changing save (delete-then-insert in the article-write
 * transaction), never hand-edited — so there is no Create/Update payload schema. `createdAt` only;
 * not soft-deletable, not an append-only audit log.
 */

/** A single ArticleWikiLink row (API representation of the `article_wiki_links` row). */
export const ArticleWikiLinkSchema = z.object({
  id: z.cuid(),
  // The article whose body contains this `[[slug]]`.
  sourceArticleId: z.cuid(),
  // The verbatim `[[slug]]` target text — the resolution key (lowercase slug shape).
  targetSlug: z.string(),
  // The matched live article when the slug currently resolves, else null (an unresolved forward
  // reference — render-time state, never an error; ADR-0029 / ADR-0059 §3).
  resolvedTargetId: z.cuid().nullable(),
  createdAt: z.iso.datetime(),
});

/**
 * A backlink ("Reference") row — one incoming wiki-link from a source article, enriched with the
 * source's title/slug for display (ADR-0059 §4). This is the shape returned by the backlinks read
 * (`GET /articles/:id/backlinks`): every readable article whose body references this one. Visibility
 * is gated server-side (a draft's backlink never leaks — ADR-0022), so only readable sources appear.
 */
export const ArticleBacklinkSchema = z.object({
  id: z.cuid(),
  sourceArticleId: z.cuid(),
  // Denormalized source fields for the "References" list (no extra round-trip on the client).
  sourceSlug: z.string(),
  sourceTitle: z.string(),
  createdAt: z.iso.datetime(),
});

export type ArticleWikiLink = z.infer<typeof ArticleWikiLinkSchema>;
export type ArticleBacklink = z.infer<typeof ArticleBacklinkSchema>;
