import { z } from "zod";

/**
 * Cross-entity search contract (ADR-0035). The API exposes `GET /search?q=&entities=&limit=` backed
 * by Meilisearch and returns one `{ hits, total }` block per requested entity; these schemas type
 * that wire shape for the web client. Single source of truth shared by api and web.
 *
 * Each hit is the small, flat document the API projects into its Meili index (see
 * apps/api/src/search/search.documents.ts) — `id` plus the searchable fields, no relations. We type
 * exactly those fields; any Meili-added metadata on a hit is simply ignored (these are used for
 * typing, not runtime parsing).
 */

/** The five searchable entities — one Meili index each. Mirrors `SEARCH_INDEXES` in the API. */
export const SEARCH_ENTITIES = [
  "assets",
  "articles",
  "users",
  "locations",
  "applications",
] as const;

export const SearchEntitySchema = z.enum(SEARCH_ENTITIES);
export type SearchEntity = z.infer<typeof SearchEntitySchema>;

// Per-entity hit documents — the indexed projection (`id` + searchable fields). `status`/`type` are
// kept as plain strings (that is what the index stores); the UI maps them to badges as needed.
export const AssetHitSchema = z.object({
  id: z.string(),
  name: z.string(),
  serial: z.string().nullable(),
  assetTag: z.string().nullable(),
  status: z.string(),
  notes: z.string().nullable(),
});

export const ArticleHitSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  excerpt: z.string().nullable(),
  status: z.string(),
});

export const UserHitSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
});

export const LocationHitSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  address: z.string().nullable(),
  floor: z.string().nullable(),
});

export const ApplicationHitSchema = z.object({
  id: z.string(),
  name: z.string(),
  vendor: z.string().nullable(),
  description: z.string().nullable(),
});

export type AssetHit = z.infer<typeof AssetHitSchema>;
export type ArticleHit = z.infer<typeof ArticleHitSchema>;
export type UserHit = z.infer<typeof UserHitSchema>;
export type LocationHit = z.infer<typeof LocationHitSchema>;
export type ApplicationHit = z.infer<typeof ApplicationHitSchema>;

/** One result block per entity: the hits for that index plus Meili's total estimate. */
function entityResult<Hit extends z.ZodType>(hit: Hit) {
  return z.object({
    hits: z.array(hit),
    total: z.number().int().nonnegative(),
  });
}

/**
 * The `GET /search` response. Each entity key is **optional**: the endpoint returns only the
 * requested `entities` (all five when the param is omitted), so a scoped query yields a subset of
 * these keys.
 *
 * `degraded` is the **outage signal** (issue #370): the API is fail-soft — when Meilisearch rejects a
 * read it still returns empty `{ hits, total }` blocks with HTTP 200 so the endpoint stays resilient,
 * but it sets `degraded: true` so a transient engine outage is distinguishable from a genuine empty
 * result. It is **optional** and defaults to `false`; a healthy response omits it (or sends `false`),
 * and the UI shows "search unavailable" only when it is `true`.
 */
export const SearchResultsSchema = z
  .object({
    assets: entityResult(AssetHitSchema),
    articles: entityResult(ArticleHitSchema),
    users: entityResult(UserHitSchema),
    locations: entityResult(LocationHitSchema),
    applications: entityResult(ApplicationHitSchema),
  })
  .partial()
  .extend({
    degraded: z.boolean().optional().default(false),
  });

export type SearchResults = z.infer<typeof SearchResultsSchema>;

/** A single entity's result block (`{ hits, total }`) for a given entity key. */
export type SearchEntityResult<E extends SearchEntity = SearchEntity> = NonNullable<
  SearchResults[E]
>;
