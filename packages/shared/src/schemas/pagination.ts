import { z } from "zod";

/**
 * Offset/limit list pagination contract (ADR-0030). Defined **once** here so every list endpoint
 * that adopts it — and the web data layer ([[0020-frontend-data-layer]]) — agrees on one wire shape
 * instead of re-litigating it per endpoint. Single source of truth for `api` and `web`.
 *
 * Two equivalent ways to address a page (the ADR allows both):
 *   - `{ limit, offset }` — the canonical/internal form (maps straight to Prisma `take`/`skip`).
 *   - `{ page, limit }`   — the 1-based convenience form; `page` is converted to `offset` by
 *     {@link offsetOf} (`offset = (page - 1) * limit`).
 * `offset` wins if both `offset` and `page` are present.
 *
 * **Default page size 50, hard maximum 200** (caps the worst-case response size for any endpoint
 * that adopts the contract). Query params arrive as strings, so the numeric fields coerce.
 */

/** Default page size when the caller omits `limit`. */
export const DEFAULT_PAGE_LIMIT = 50;
/** Hard ceiling on `limit` — a request asking for more is rejected (400), never silently served. */
export const MAX_PAGE_LIMIT = 200;

/**
 * Query params for a paginated list. All optional with sensible defaults, so an endpoint that adds
 * pagination stays callable with no query string (page 1, 50 rows). Rejects `limit` over the hard
 * max and negative offsets/pages with a 400 at the edge.
 */
export const PageQuerySchema = z.object({
  /** 1..200; defaults to 50. Values above the hard max are rejected (not clamped). */
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  /** 0-based row offset (canonical). Mutually addressable with `page`; `offset` wins if both given. */
  offset: z.coerce.number().int().min(0).optional(),
  /** 1-based page number (convenience). Converted to `offset` via {@link offsetOf}. */
  page: z.coerce.number().int().min(1).optional(),
});

export type PageQuery = z.infer<typeof PageQuerySchema>;

/**
 * Resolve a {@link PageQuery} to the canonical `{ take, skip }` Prisma arguments. `offset` is
 * authoritative; otherwise `(page - 1) * limit`; otherwise 0. `limit` always carries its default.
 */
export function offsetOf(query: PageQuery): { take: number; skip: number } {
  const { limit, offset, page } = query;
  const skip = offset ?? (page !== undefined ? (page - 1) * limit : 0);
  return { take: limit, skip };
}

/**
 * The list envelope returned by a paginated endpoint: the page of `items` plus the `total` row
 * count (matching the same filters, ignoring pagination) and the `limit`/`offset` that produced it,
 * so a client can compute "has more" / page numbers without guessing.
 */
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * A zod schema for a {@link Page} of `item`. Used to type/validate a paginated response in `web`
 * and to build per-entity list-response DTOs in `api` (e.g. `pageSchema(ArticleListItemSchema)`).
 */
export function pageSchema<Item extends z.ZodType>(item: Item) {
  return z.object({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
  });
}

/**
 * Assemble a {@link Page} envelope from a resolved page of `items`, the matching `total`, and the
 * {@link PageQuery} that produced them. Echoes back the **effective** `limit`/`offset` (defaults
 * applied) so the response always advertises the real window, never the raw (possibly empty) query.
 */
export function pageOf<T>(items: T[], total: number, query: PageQuery): Page<T> {
  const { take, skip } = offsetOf(query);
  return { items, total, limit: take, offset: skip };
}
