import { z } from "zod";

/**
 * Offset-based list pagination — the one contract every paginated `GET` list shares, defined once
 * here and consumed by `api` (query parsing + the `Page<T>` response envelope) and `web` (the data
 * layer). See docs/03-decisions/0030-list-pagination-contract.md (ADR-0030).
 *
 * Why offset (not cursor): simplest and familiar; the deep-page cost and insert-instability are
 * accepted at this scale (a 5–20-person team). Revisit cursor if a history table grows fast.
 *
 * Query contract: the caller may pass **either** `{ limit, offset }` (raw window) **or**
 * `{ page, limit }` (1-based page number). `limit` defaults to {@link DEFAULT_PAGE_LIMIT} and is
 * **hard-capped** at {@link MAX_PAGE_LIMIT} — a value over the max is **rejected** (→ 400 at the
 * controller), never silently clamped, so a client never believes it asked for more than it got.
 */

/** Default page size when `limit` is omitted. */
export const DEFAULT_PAGE_LIMIT = 50;
/** Hard maximum page size. A `limit` above this is rejected (400), not clamped (ADR-0030). */
export const MAX_PAGE_LIMIT = 200;

/**
 * Raw pagination query as it arrives on the wire (all strings via `@Query`, hence `z.coerce`).
 * `limit` is bounded 1..{@link MAX_PAGE_LIMIT}. `offset` (≥0) and `page` (≥1) are mutually-redundant
 * ways to address the window; the transform below normalizes them to a canonical `{ limit, offset }`.
 * `offset` wins if both are given (it is the lower-level address).
 */
export const PageQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_LIMIT)
      .default(DEFAULT_PAGE_LIMIT),
    offset: z.coerce.number().int().min(0).optional(),
    page: z.coerce.number().int().min(1).optional(),
  })
  .transform(({ limit, offset, page }) => ({
    limit,
    // Prefer an explicit offset; otherwise derive it from the 1-based page; default to the first page.
    offset: offset ?? (page !== undefined ? (page - 1) * limit : 0),
  }));

/**
 * The normalized pagination window: a `limit` (page size) and a zero-based `offset`. This is the
 * **output** of {@link PageQuerySchema} — what services receive — regardless of which input shape
 * (`offset` or `page`) the caller used.
 */
export type PageQuery = z.infer<typeof PageQuerySchema>;

/**
 * The metadata every `Page<T>` envelope carries, minus the `items` array. Kept separate so the API
 * can build a concrete `Page<SomeDto>` OpenAPI class by composing this with a typed `items` field.
 */
export const PageMetaSchema = z.object({
  // Total rows matching the query across ALL pages (the count over the same `where` as `items`).
  total: z.number().int().min(0),
  // The page size that was applied (echoes the resolved `limit`).
  limit: z.number().int().min(1),
  // The zero-based offset of this page's first item.
  offset: z.number().int().min(0),
});

export type PageMeta = z.infer<typeof PageMetaSchema>;

/**
 * A generic `Page<T>` envelope: `{ items, total, limit, offset }`. Call with the item schema to get
 * a concrete page schema, e.g. `pageSchema(ArticleListItemSchema)`. The runtime envelope shape is
 * the same for every list; only `items`'s element type changes.
 */
export function pageSchema<T extends z.ZodType>(item: T) {
  return PageMetaSchema.extend({ items: z.array(item) });
}

/**
 * The page envelope as a plain generic type (no zod), for typing service/controller returns where a
 * concrete schema isn't needed: `Page<Article>`, `Page<AssetListItem>`, …
 */
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Translate a normalized {@link PageQuery} into Prisma's `findMany` window args. `take` is the page
 * size; `skip` is the offset. Use the SAME `where` for the paired `count` so the total can't drift
 * from the returned page.
 */
export function offsetOf(query: PageQuery): { take: number; skip: number } {
  return { take: query.limit, skip: query.offset };
}

/**
 * Assemble a {@link Page} envelope from a fetched slice and the matching total. `limit`/`offset` are
 * echoed from the query so the client can compute "has more" (`offset + items.length < total`).
 */
export function pageOf<T>(items: T[], total: number, query: PageQuery): Page<T> {
  return { items, total, limit: query.limit, offset: query.offset };
}
