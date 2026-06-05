import { z } from "zod";
import { ArticleSchema, ArticleStatusSchema } from "./article";
import { pageSchema } from "./pagination";

/**
 * Lean read shape for the article list (`GET /articles`). It is the full {@link ArticleSchema}
 * **minus `content`** — the entire Markdown body, the largest column in the schema — which a list
 * view never renders. `excerpt` is kept (that's what the list shows). The detail reads
 * (`GET /articles/:id`, `GET /articles/by-slug/:slug`) still return the full `Article` with `content`.
 *
 * On top of the base columns the list adds two card-UI affordances (ADR-0042), both produced by the
 * list query so the card never loads the body and there is no N+1:
 *   - `linkCount` — how many `ArticleLink`s the article has (Prisma relation `_count`); the card shows
 *     a "linked" indicator. `linkCount > 0` ⇔ the article is linked to ≥1 Asset/Application.
 *   - `readingMinutes` — estimated reading time in whole minutes, read from the maintained
 *     `Article.readingMinutes` column (derived from `content` on write at ~200 words/min; min 1 for any
 *     non-empty body). The metric is precomputed, so the list stays lean — it never derives from the
 *     (omitted) body at read time.
 *
 * `authorId` (the owner/author) is already part of the base shape — the card reads it directly.
 *
 * See docs/03-decisions/0030-list-pagination-contract.md, docs/03-decisions/0042-article-versioning-and-linking.md
 * and the backend-performance-optimization analysis (#3: "GET /articles ships the full markdown content").
 */
export const ArticleListItemSchema = ArticleSchema.omit({ content: true }).extend({
  /** Number of `ArticleLink`s on this article (≥ 0). `linkCount > 0` means the article is linked. */
  linkCount: z.number().int().nonnegative(),
  /** Estimated reading time in whole minutes (≥ 0; 0 only for an empty body). */
  readingMinutes: z.number().int().nonnegative(),
});

/** The paginated `GET /articles` envelope: `{ items: ArticleListItem[], total, limit, offset }`. */
export const ArticleListPageSchema = pageSchema(ArticleListItemSchema);

/**
 * `?linked=` filter for `GET /articles` (ADR-0042). Only `only` is defined — restrict the page to
 * articles that have ≥1 `ArticleLink`. Omitted = no link filter (the default: linked AND unlinked).
 * The value set is an ALLOWLIST: any other value is rejected with 400 at the edge (consistent with
 * ADR-0030's "unknown filter value → 400, never silently ignored"). It is NOT `optional()` here —
 * the controller only parses it when the query param is present, so an unknown value always errors.
 */
export const ArticleLinkedFilterSchema = z.enum(["only"]);

/**
 * `?linkedTo=` narrows the linked filter to one or more target kinds (ADR-0042 / #198): `asset` keeps
 * articles linked to ≥1 Asset, `application` those linked to ≥1 Application. **Multi-value (#198):**
 * the wire value is comma-encoded (`asset,application`) and the kinds **OR-combine** (the union of
 * both); the controller validates each element against this allowlist (same 400-on-unknown contract
 * as {@link ArticleLinkedFilterSchema}). Meaningful only alongside `linked=only`; on its own any
 * `linkedTo` is treated as an implicit `linked=only` narrowed to the selected target kind(s).
 */
export const ArticleLinkedToSchema = z.enum(["asset", "application"]);

/**
 * Multi-value list-filter contract for `GET /articles` (#198). The `status`, `categoryId` and
 * `linkedTo` filters each accept **several** values that **OR-combine within the filter** (union)
 * and **AND-combine across filters** (intersection). On the wire each is a single comma-encoded
 * query param (option A — matches the `search.ts` `entities.join(",")` precedent and keeps the
 * `useListParams` model of one string per filter name); the controller splits on `,` and validates
 * **each element** against the element schema below, so an unknown element still maps to **400**
 * (ADR-0030) and a single value still parses (backward-compat with existing URLs / deep-links).
 *
 * These are the **element** schemas (the per-value allowlists). The array shape is parsed in the
 * API controller (`parseEnumArrayQuery` / `parseCuidArrayQuery`) rather than baked into a zod
 * `.array()` here, because the controller already owns the comma-split + 400-on-unknown contract for
 * raw `@Query` strings (the global ZodValidationPipe only validates `@Body()` DTOs).
 *
 * `ArticleStatusFilterSchema` is the existing {@link ArticleStatusSchema} element re-exported under a
 * filter-intent name; `ArticleLinkedToFilterSchema` aliases {@link ArticleLinkedToSchema}. `categoryId`
 * elements are validated as cuids by the controller's `parseCuidArrayQuery` (no enum — open value set).
 */
export const ArticleStatusFilterSchema = ArticleStatusSchema;
export const ArticleLinkedToFilterSchema = ArticleLinkedToSchema;

export type ArticleListItem = z.infer<typeof ArticleListItemSchema>;
export type ArticleListPage = z.infer<typeof ArticleListPageSchema>;
export type ArticleLinkedFilter = z.infer<typeof ArticleLinkedFilterSchema>;
export type ArticleLinkedTo = z.infer<typeof ArticleLinkedToSchema>;
