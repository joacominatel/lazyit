"use client";

import { useCallback, useMemo, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  buildFiltersPatch,
  buildNextUrl,
  multiFilterPatch,
  singleFilterPatch,
} from "./list-params-url";

/**
 * URL-synced list view-state (q / filters / sort / paging) for App Router list pages.
 *
 * The URL search params are the single source of truth: state is *derived* from `useSearchParams`
 * and every setter writes back via `router.replace(..., { scroll: false })`. That makes a filtered
 * list shareable, bookmarkable and Back-navigable, and lets other surfaces (e.g. the dashboard)
 * deep-link into a pre-filtered list — none of which is possible when this lives in component
 * `useState`. A list page can drop its `useState` cluster for one `useListParams(...)` call and feed
 * the returned {@link ListParams.query} straight into its data hook.
 *
 * Param wire names (what lands in the URL *and* what {@link ListParams.query} emits) match the
 * merged backend list contract (#104): `q`, `sort`, `dir`, `limit`, `offset`, `page`, plus each
 * declared filter under its own name. The server echoes `{ items, total, limit, offset }`.
 *
 * Debounce is intentionally NOT this hook's job — a fast typist would otherwise push a URL entry per
 * keystroke. Callers debounce the raw `q` input themselves (see `useDebouncedValue`) and call
 * `setQ` with the settled value.
 *
 * Resetting behaviour: any change that yields a different result set — `setQ`, `setFilter`,
 * `clearFilters` — resets `offset`/`page` back to the first page. Re-sorting and paging do not.
 */

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

export interface ListParams {
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

  /** Set the search text (resets to the first page). Pass `""` to clear. */
  setQ: (value: string) => void;
  /** Set the sort field + direction explicitly. */
  setSort: (field: string | undefined, dir?: SortDir) => void;
  /**
   * Toggle sorting by `field`: first click sorts ascending, clicking the active field flips the
   * direction. Mirrors the table-header sort affordance the list pages already use.
   */
  toggleSort: (field: string) => void;
  /** Set one named filter (resets to the first page). Setting it to its default clears it. */
  setFilter: (name: string, value: string) => void;
  /**
   * Set a **multi-value** named filter from a list of values (#198), comma-encoded into the one
   * URL param (e.g. `?status=DRAFT,PUBLISHED` — option A, matching the `search.ts` precedent).
   * Empty/blank values are dropped and the rest de-duplicated; an empty result clears the filter
   * (param removed → back to its default). Resets to the first page (a new result set). Read the
   * values back with {@link ListParams.getFilterValues}.
   */
  setFilterValues: (name: string, values: string[]) => void;
  /**
   * Set **several** named filters in ONE navigation (#217). Each entry is encoded with the same
   * per-key rules as the single setters — a `string` value follows {@link setFilter} (default
   * collapses to "cleared"), a `string[]` follows {@link setFilterValues} (clean/de-dupe/
   * comma-encode, empty clears) — then the whole patch is committed atomically with one
   * `router.replace`. Use this whenever one handler changes two related keys (e.g. clearing
   * `linked` + `linkedTo` together, or writing a `from`/`to` date pair): firing two separate
   * setters instead makes the second `router.replace` overwrite the first from a stale snapshot,
   * dropping one key (the bug this method exists to prevent). Resets to the first page.
   */
  setFilters: (patch: Record<string, string | string[]>) => void;
  /**
   * Read a multi-value filter as a `string[]` (#198) — the inverse of {@link setFilterValues}.
   * Splits the comma-encoded param, trims, drops empties and de-duplicates. A single-value param
   * yields a one-element array (backward-compatible with `setFilter`); a filter at its default
   * yields `[]`.
   */
  getFilterValues: (name: string) => string[];
  /** Set the row offset (paging; does not reset). */
  setOffset: (offset: number) => void;
  /** Set the 1-based page (paging; does not reset). */
  setPage: (page: number) => void;
  /** Clear every declared filter (and `q`), back to the first page. Leaves sort/limit untouched. */
  clearFilters: () => void;

  /** Backend-shaped query ready to pass to a data hook (see {@link ListQuery}). */
  query: ListQuery;
  /** True when any declared filter or `q` is non-default — drives a "Clear filters" control. */
  filtersActive: boolean;
}

/**
 * @see ListParams for the returned API and {@link ListQuery} for the data-hook-ready `query`.
 */
export function useListParams(options: UseListParamsOptions = {}): ListParams {
  const {
    filters: filterDefaults = {},
    defaultLimit = 50,
    defaultSort,
    defaultDir = "desc",
  } = options;

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // --- derive current state from the URL (source of truth) ---
  const q = searchParams.get("q") ?? "";

  const sort = searchParams.get("sort") ?? defaultSort;
  const rawDir = searchParams.get("dir");
  const dir: SortDir = rawDir === "asc" || rawDir === "desc" ? rawDir : defaultDir;

  const limitParam = Number(searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : defaultLimit;

  const offsetParam = Number(searchParams.get("offset"));
  const offset = Number.isFinite(offsetParam) && offsetParam >= 0 ? offsetParam : 0;

  const page = Math.floor(offset / limit) + 1;

  const filterNames = useMemo(() => Object.keys(filterDefaults), [filterDefaults]);

  const filters = useMemo(() => {
    const out: Record<string, string> = {};
    for (const name of filterNames) {
      out[name] = searchParams.get(name) ?? filterDefaults[name];
    }
    return out;
  }, [filterNames, filterDefaults, searchParams]);

  // --- writer: rebuild the param string from the current URL + a patch, then replace() ---
  // The patch is applied as a whole (see buildNextUrl), so a multi-key patch lands in one
  // router.replace — two keys changed together can never clobber each other (#217).
  //
  // `commit` MUST be referentially stable across renders (#487): consumers spread the derived
  // setters into child props (`onChange`, `onDebouncedChange`, `onOffsetChange`, …), so a setter
  // whose identity changes every render can drive child effects to re-fire and re-commit — a
  // feedback loop that hits the browser's `history.replaceState()` rate limit (>100 calls / 10s →
  // SecurityError). The naive fix — dropping `searchParams`/`pathname` from the deps — would close
  // over a STALE snapshot and rebuild the next URL from outdated params, dropping concurrent keys.
  // Instead we route the latest `{ searchParams, pathname }` through a ref updated every render and
  // depend only on the stable `router`. The ref always holds this render's values, so `commit`
  // reads fresh URL state at call time while keeping a constant identity — race-free, no stale URL.
  const latest = useRef({ searchParams, pathname });
  latest.current = { searchParams, pathname };

  const commit = useCallback(
    (patch: Record<string, string | number | undefined>) => {
      const { searchParams: sp, pathname: path } = latest.current;
      const href = buildNextUrl(sp.toString(), path, patch);
      router.replace(href, { scroll: false });
    },
    [router],
  );

  const setQ = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      // A new search is a different result set → reset paging.
      commit({ q: trimmed || undefined, offset: undefined });
    },
    [commit],
  );

  const setSort = useCallback(
    (field: string | undefined, nextDir?: SortDir) => {
      commit({
        sort: field,
        // Drop dir when sort is cleared; otherwise persist the chosen direction.
        dir: field ? (nextDir ?? defaultDir) : undefined,
      });
    },
    [commit, defaultDir],
  );

  const toggleSort = useCallback(
    (field: string) => {
      // First sort on a field → ascending; re-click the active field → flip direction.
      const nextDir: SortDir = sort === field && dir === "asc" ? "desc" : "asc";
      commit({ sort: field, dir: nextDir });
    },
    [commit, sort, dir],
  );

  const setFilter = useCallback(
    (name: string, value: string) => {
      // A filter change is a different result set → reset paging.
      commit({ ...singleFilterPatch(name, value, filterDefaults), offset: undefined });
    },
    [commit, filterDefaults],
  );

  const setFilterValues = useCallback(
    (name: string, values: string[]) => {
      // Comma-encode (#198): clean, de-dupe, join into the one param; empty → clear the filter.
      commit({ ...multiFilterPatch(name, values, filterDefaults), offset: undefined });
    },
    [commit, filterDefaults],
  );

  const setFilters = useCallback(
    (patch: Record<string, string | string[]>) => {
      // One patch → one commit → one router.replace: every key is written atomically (#217).
      commit(buildFiltersPatch(patch, filterDefaults));
    },
    [commit, filterDefaults],
  );

  const getFilterValues = useCallback(
    (name: string): string[] => {
      const raw = filters[name] ?? "";
      if (raw === "" || raw === (filterDefaults[name] ?? "")) return [];
      return [
        ...new Set(
          raw
            .split(",")
            .map((v) => v.trim())
            .filter((v) => v !== ""),
        ),
      ];
    },
    [filters, filterDefaults],
  );

  const setOffset = useCallback(
    (next: number) => {
      commit({ offset: next > 0 ? next : undefined });
    },
    [commit],
  );

  const setPage = useCallback(
    (nextPage: number) => {
      const nextOffset = Math.max(0, (nextPage - 1) * limit);
      commit({ offset: nextOffset > 0 ? nextOffset : undefined });
    },
    [commit, limit],
  );

  const clearFilters = useCallback(() => {
    const patch: Record<string, string | undefined> = { q: undefined, offset: undefined };
    for (const name of filterNames) patch[name] = undefined;
    commit(patch);
  }, [commit, filterNames]);

  // --- derived: backend-shaped query + the active flag ---
  const filtersActive = useMemo(() => {
    if (q !== "") return true;
    return filterNames.some((name) => filters[name] !== (filterDefaults[name] ?? ""));
  }, [q, filterNames, filters, filterDefaults]);

  const query = useMemo<ListQuery>(() => {
    const out: ListQuery = { limit, offset, page };
    if (q) out.q = q;
    if (sort) {
      out.sort = sort;
      out.dir = dir;
    }
    for (const name of filterNames) {
      const value = filters[name];
      if (value !== (filterDefaults[name] ?? "")) out[name] = value;
    }
    return out;
  }, [q, sort, dir, limit, offset, page, filterNames, filters, filterDefaults]);

  return {
    q,
    sort,
    dir,
    offset,
    page,
    limit,
    filters,
    setQ,
    setSort,
    toggleSort,
    setFilter,
    setFilterValues,
    setFilters,
    getFilterValues,
    setOffset,
    setPage,
    clearFilters,
    query,
    filtersActive,
  };
}
