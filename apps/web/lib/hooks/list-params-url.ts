/**
 * Pure URL-patch + URL-derivation helpers for {@link useListParams} — the framework-agnostic core of
 * both its writer AND its reader.
 *
 * `useListParams` is a thin React shell over these functions: it reads the current
 * `searchParams`/`pathname` from `next/navigation`, derives its view-state with {@link deriveListState}
 * (the reader), and on every setter builds a patch with the encoders below and hands it to
 * {@link buildNextUrl} for a single `router.replace` (the writer). Keeping this here (no React, no
 * `next/navigation`) makes the atomicity guarantee — multiple keys applied in ONE write, never
 * last-write-wins — directly unit-testable without a DOM or a router (see `list-params-url.test.ts`);
 * the hook itself stays deferred under ADR-0012.
 *
 * {@link deriveListState} being pure is the load-bearing piece of the ADR-0067 filtered-prefetch work
 * (#733): a Server Component can derive the SAME view-state from a request URL that the client hook
 * derives in the browser, so a server-prefetch key can be made byte-identical to the client's — with
 * no bespoke re-implementation to drift out of sync (see `docs/04-development/ssr-prefetch-recipe.md`).
 */

import { MAX_PAGE_LIMIT } from "@lazyit/shared";

/** A patch value per key: `undefined`/`""` clears the param, anything else sets it (stringified). */
export type ParamPatch = Record<string, string | number | undefined>;

/** Sort direction, matching the backend `dir` param. */
export type SortDir = "asc" | "desc";

export interface UseListParamsOptions {
  /**
   * The named string filters this list supports (e.g. `status`, `role`, `type`, `lowStock`,
   * `isCritical`), each mapped to its **default** value. A filter equal to its default is treated as
   * inactive: it is omitted from the URL and from `query`, and does not count toward `filtersActive`.
   * Use a sentinel like `"ALL"` (or `""`) for "no filter". A filter not listed here is ignored.
   */
  filters?: Record<string, string>;
  /** Default page size (`limit`). Defaults to 50, matching the API list default (ADR-0030). */
  defaultLimit?: number;
  /** Default sort field (a name from the resource's server allowlist). Optional. */
  defaultSort?: string;
  /** Default sort direction when `defaultSort` is set. Defaults to `"desc"`. */
  defaultDir?: SortDir;
}

/**
 * The backend-shaped query object. Keys map 1:1 to the #104 list-contract param names. Undefined
 * keys are omitted (a value at its default / empty is dropped) so the object can be spread straight
 * into a data hook without sending defaults. `dir` is only present when `sort` is.
 */
export interface ListQuery {
  q?: string;
  sort?: string;
  dir?: SortDir;
  limit: number;
  offset: number;
  /** Page number derived from offset/limit (1-based), for endpoints that prefer `page` over `offset`. */
  page: number;
  /** Active named filters (default-valued ones omitted), spread alongside the params above. */
  [filterName: string]: string | number | undefined;
}

/**
 * The read side of {@link useListParams} — the derived view-state a list page renders. This is the
 * shape {@link deriveListState} returns and (minus the setters) the shape the hook exposes.
 */
export interface DerivedListState {
  /** Current search text (`""` when absent). */
  q: string;
  /** Current sort field, or `undefined` when none is set. */
  sort: string | undefined;
  /** Current sort direction (defaults to `defaultDir`, `"desc"`, when no sort is set). */
  dir: SortDir;
  /** Current row offset (0-based). */
  offset: number;
  /** Current page (1-based), derived from offset/limit. */
  page: number;
  /** Current page size. */
  limit: number;
  /** Current value of each declared filter (its default when absent from the URL). */
  filters: Record<string, string>;
  /** True when any declared filter or `q` is non-default — drives a "Clear filters" control. */
  filtersActive: boolean;
  /** Backend-shaped query ready to pass to a data hook (see {@link ListQuery}). */
  query: ListQuery;
}

/**
 * The minimal read interface {@link deriveListState} needs from a search-param bag: just `.get`.
 * Both the browser's `ReadonlyURLSearchParams` (from `useSearchParams()`) and a plain `URLSearchParams`
 * (built server-side from a Server Component's `searchParams` prop via {@link toURLSearchParams})
 * satisfy it — which is what lets one pure function serve client and server identically (#733).
 */
export interface ReadonlyParams {
  get(name: string): string | null;
}

/**
 * Derive a list page's view-state from URL search params + per-page defaults — a **pure** function
 * (no React, no `next/navigation`) shared by the client hook and by Server Components.
 *
 * This is the exact derivation {@link useListParams} performs on the client, extracted so a
 * server-prefetch (ADR-0067 / #733) can reproduce the client's query key from a request URL WITHOUT
 * a bespoke re-implementation (which would silently drift and cache-miss into a double-fetch). The
 * `limit` clamp to `MAX_PAGE_LIMIT` (a tampered `?limit=5000` degrades to the max page instead of a
 * 400, issue #508) and the "value-at-default is omitted from `query`" rule both live here so client
 * and server agree byte-for-byte.
 */
export function deriveListState(
  params: ReadonlyParams,
  options: UseListParamsOptions = {},
): DerivedListState {
  const {
    filters: filterDefaults = {},
    defaultLimit = 50,
    defaultSort,
    defaultDir = "desc",
  } = options;

  const q = params.get("q") ?? "";

  const sort = params.get("sort") ?? defaultSort;
  const rawDir = params.get("dir");
  const dir: SortDir = rawDir === "asc" || rawDir === "desc" ? rawDir : defaultDir;

  // Clamp the URL `limit` to the API's hard cap (ADR-0030): the server REJECTS (400) a limit over
  // MAX_PAGE_LIMIT — never silently clamps — and `resource-table.tsx` renders rows unvirtualized, so
  // a hand-edited/bookmarked `?limit=5000` would both 400 and (if honoured) freeze the tab. We cap
  // here so a tampered URL degrades to the max page instead of erroring (issue #508).
  const limitParam = Number(params.get("limit"));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, MAX_PAGE_LIMIT)
      : defaultLimit;

  const offsetParam = Number(params.get("offset"));
  const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? offsetParam : 0;

  const page = Math.floor(offset / limit) + 1;

  const filterNames = Object.keys(filterDefaults);
  const filters: Record<string, string> = {};
  for (const name of filterNames) {
    filters[name] = params.get(name) ?? filterDefaults[name];
  }

  const filtersActive =
    q !== "" || filterNames.some((name) => filters[name] !== (filterDefaults[name] ?? ""));

  const query: ListQuery = { limit, offset, page };
  if (q) query.q = q;
  if (sort) {
    query.sort = sort;
    query.dir = dir;
  }
  for (const name of filterNames) {
    const value = filters[name];
    if (value !== (filterDefaults[name] ?? "")) query[name] = value;
  }

  return { q, sort, dir, offset, page, limit, filters, filtersActive, query };
}

/**
 * Build a `URLSearchParams` from a Next.js Server Component `searchParams` prop (a plain
 * `{ [key]: string | string[] | undefined }` bag), so {@link deriveListState} can read it the same
 * way it reads the browser's `useSearchParams()` (#733). `undefined` keys are skipped; a repeated
 * param (`string[]`) collapses to its first value — list pages comma-encode multi-value filters into a
 * single param (see {@link multiFilterPatch}), so repeated params don't occur on the piloted routes.
 */
export function toURLSearchParams(
  searchParams: Record<string, string | string[] | undefined>,
): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") out.set(key, value);
    else if (Array.isArray(value) && value[0] != null) out.set(key, value[0]);
  }
  return out;
}

/**
 * Apply a multi-key `patch` to the current `search` string and return the next URL (path + query).
 *
 * This is the pure core of the hook's `commit`: it starts from the *current* params (so unrelated
 * keys are preserved) and applies every patched key in one pass. Because the whole patch lands in a
 * single `URLSearchParams`, two keys changed together can never clobber each other — the regression
 * fixed in #217 (two sequential `router.replace` calls from one handler, the second re-emitting a
 * stale snapshot) is structurally impossible when callers route both keys through one patch.
 *
 * `undefined` or `""` deletes the key; any other value is set via `String(value)`. When the
 * resulting query is empty the bare `pathname` is returned (no trailing `?`).
 */
export function buildNextUrl(
  search: string,
  pathname: string,
  patch: ParamPatch,
): string {
  const next = new URLSearchParams(search);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === "") {
      next.delete(key);
    } else {
      next.set(key, String(value));
    }
  }
  const qs = next.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/**
 * One-key patch entry for a **single-value** filter: clears the key when `value` equals the filter's
 * default (the inactive sentinel), otherwise sets it. Mirrors `setFilter`'s default-collapse rule.
 */
export function singleFilterPatch(
  name: string,
  value: string,
  defaults: Record<string, string>,
): ParamPatch {
  const isDefault = value === (defaults[name] ?? "");
  return { [name]: isDefault ? undefined : value };
}

/**
 * One-key patch entry for a **multi-value** filter (#198): clean (trim + drop empties), de-dupe and
 * comma-encode the values into the single param; an empty result (or the default) clears the key.
 * Mirrors `setFilterValues`' encoding so single- and multi-key writes agree byte-for-byte.
 */
export function multiFilterPatch(
  name: string,
  values: string[],
  defaults: Record<string, string>,
): ParamPatch {
  const cleaned = [...new Set(values.map((v) => v.trim()).filter((v) => v !== ""))];
  const encoded = cleaned.join(",");
  const isDefault = encoded === "" || encoded === (defaults[name] ?? "");
  return { [name]: isDefault ? undefined : encoded };
}

/**
 * Build the merged patch for {@link ListParams.setFilters}: apply the single/multi default-collapse
 * rule per key (string ⇒ single, string[] ⇒ multi) into ONE patch, then reset paging (`offset`).
 * The caller commits the whole thing in a single navigation, so every key in `patch` is written
 * atomically — this is what lets a handler change two filters at once without dropping either.
 */
export function buildFiltersPatch(
  patch: Record<string, string | string[]>,
  defaults: Record<string, string>,
): ParamPatch {
  const out: ParamPatch = {};
  for (const [name, value] of Object.entries(patch)) {
    const entry = Array.isArray(value)
      ? multiFilterPatch(name, value, defaults)
      : singleFilterPatch(name, value, defaults);
    Object.assign(out, entry);
  }
  // A filter change is a different result set → back to the first page.
  out.offset = undefined;
  return out;
}
