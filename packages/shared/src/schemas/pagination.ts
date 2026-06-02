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
 *
 * Sort contract (ADR-0030 amendment, 2026-06-01): the caller may also pass `sort` (a field name) and
 * `dir` (`asc`|`desc`). The shape only validates that they are well-formed strings; the **set of
 * sortable fields is per-resource** and each list endpoint validates `sort` against its own
 * ALLOWLIST (an unknown field is rejected → 400, never silently ignored), so the sort is real and
 * authoritative across the full result set — not a page-local re-order. `dir` defaults to `asc` only
 * when a `sort` is given; with no `sort` the service keeps its own default ordering.
 *
 * Soft-delete view (ADR-0030 addendum, 2026-06-01): the caller may also pass `deleted` to choose
 * which soft-delete slice a list returns — `active` (the default: only LIVE rows, the historical
 * behaviour) or `only` (ONLY soft-deleted rows, powering the web "Show archived" + Restore view).
 * `deleted=only` is **ADMIN-gated at the controller** (a non-admin asking for it → 403); the shape
 * here only types/documents the contract. There is intentionally no "all" (live + deleted mixed): a
 * list is one slice at a time. See ADR-0041 (restore endpoints) and ADR-0032 (the read filter the
 * `only` slice bypasses via the `includeSoftDeleted` escape hatch).
 */

/** Default page size when `limit` is omitted. */
export const DEFAULT_PAGE_LIMIT = 50;
/** Hard maximum page size. A `limit` above this is rejected (400), not clamped (ADR-0030). */
export const MAX_PAGE_LIMIT = 200;

/** Sort direction for a paginated list. Defaults to `asc` when a `sort` field is supplied. */
export const SortDirSchema = z.enum(["asc", "desc"]);
export type SortDir = z.infer<typeof SortDirSchema>;

/**
 * Which soft-delete slice a paginated list returns (ADR-0030 addendum / ADR-0041):
 *   - `active` — only LIVE rows (`deletedAt IS NULL`). The default and the historical behaviour.
 *   - `only`   — only SOFT-DELETED rows (`deletedAt IS NOT NULL`). ADMIN-only (403 otherwise); powers
 *                the web "Show archived" + Restore view. Bypasses the ADR-0032 read filter via its
 *                sanctioned `includeSoftDeleted` escape hatch.
 */
export const DeletedFilterSchema = z.enum(["active", "only"]);
export type DeletedFilter = z.infer<typeof DeletedFilterSchema>;

/**
 * Raw pagination query as it arrives on the wire (all strings via `@Query`, hence `z.coerce`).
 * `limit` is bounded 1..{@link MAX_PAGE_LIMIT}. `offset` (≥0) and `page` (≥1) are mutually-redundant
 * ways to address the window; the transform below normalizes them to a canonical
 * `{ limit, offset, sort?, dir? }`. `offset` wins if both are given (it is the lower-level address).
 * `sort` is carried through verbatim (the per-resource allowlist validates it downstream); `dir` is
 * normalized to `asc` when a `sort` is present but `dir` is omitted, and dropped entirely when no
 * `sort` is given (so the service falls back to its own default ordering). `deleted` selects the
 * soft-delete slice (default `active`); the ADMIN gate for `only` lives at the controller.
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
    // The field to sort by. NOT enumerated here — the set of sortable fields is per-resource, so each
    // list endpoint validates this against its own allowlist (resolveSort) and 400s on an unknown one.
    sort: z.string().trim().min(1).max(64).optional(),
    // Sort direction. Only meaningful alongside `sort`; defaults to `asc` in the transform.
    dir: SortDirSchema.optional(),
    // Soft-delete slice (ADR-0030 addendum / ADR-0041). Omitted → `active` (live rows only). `only`
    // returns soft-deleted rows and is ADMIN-gated at the controller (a non-admin → 403).
    deleted: DeletedFilterSchema.default("active"),
  })
  .transform(({ limit, offset, page, sort, dir, deleted }) => ({
    limit,
    // Prefer an explicit offset; otherwise derive it from the 1-based page; default to the first page.
    offset: offset ?? (page !== undefined ? (page - 1) * limit : 0),
    // Carry the sort field through verbatim; the per-resource allowlist validates it. Only attach a
    // direction when a sort field is present (default asc) — no sort ⇒ no dir ⇒ service default order.
    ...(sort !== undefined ? { sort, dir: dir ?? "asc" } : {}),
    // Always present (defaulted to `active`), so a service never has to guess the soft-delete slice.
    deleted,
  }));

/**
 * The normalized pagination window: a `limit` (page size), a zero-based `offset`, an optional
 * `sort`/`dir` pair, and the resolved soft-delete slice (`deleted`, always present, default
 * `active`). This is the **output** of {@link PageQuerySchema} — what services receive — regardless
 * of which input shape (`offset` or `page`) the caller used. `sort`/`dir` are present together or
 * not at all.
 */
export type PageQuery = z.infer<typeof PageQuerySchema>;

/**
 * Resolve a normalized {@link PageQuery}'s `sort`/`dir` into a Prisma `orderBy` against a
 * per-resource allowlist. The allowlist maps each PUBLIC sort key (what the client sends in `sort`)
 * to the Prisma field name to order by — letting the wire key differ from the column when useful, and
 * crucially bounding the sortable surface so a client can never order by an arbitrary/secret column.
 *
 *  - No `sort` on the query → returns `undefined` (the caller uses its own default ordering).
 *  - `sort` present and **in** the allowlist → `{ [prismaField]: dir }`.
 *  - `sort` present but **not** in the allowlist → throws `UnknownSortFieldError`, which each
 *    controller/service maps to a 400 listing the valid fields. Never silently ignored.
 */
export class UnknownSortFieldError extends Error {
  constructor(
    readonly field: string,
    readonly allowed: string[],
  ) {
    super(
      `Unknown sort field "${field}". Sortable fields: ${allowed.join(", ")}`,
    );
    this.name = "UnknownSortFieldError";
  }
}

/**
 * Translate a {@link PageQuery}'s `sort`/`dir` into a single-key Prisma `orderBy` using the given
 * per-resource allowlist (publicKey → prismaField). Returns `undefined` when no `sort` was supplied;
 * throws {@link UnknownSortFieldError} for a key not in the allowlist. Keep this generic in the
 * Prisma orderBy element type so each service can pass its own `Prisma.XOrderByWithRelationInput`.
 */
export function resolveSort<TOrderBy>(
  query: Pick<PageQuery, "sort" | "dir">,
  allowlist: Record<string, string>,
): TOrderBy | undefined {
  if (query.sort === undefined) return undefined;
  const prismaField = allowlist[query.sort];
  if (prismaField === undefined) {
    throw new UnknownSortFieldError(query.sort, Object.keys(allowlist));
  }
  return { [prismaField]: query.dir ?? "asc" } as TOrderBy;
}

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
