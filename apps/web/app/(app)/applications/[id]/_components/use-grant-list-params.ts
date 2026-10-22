"use client";

import type { ApplicationGrantStatus } from "@lazyit/shared";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import type { ApplicationGrantPageParams } from "@/lib/api/endpoints/applications";
import {
  clearGrantFiltersPatch,
  deriveGrantPageParams,
  GRANT_LIST_OPTIONS,
  grantLevelPatch,
  grantOffsetPatch,
  grantSearchPatch,
  grantStatusPatch,
} from "@/lib/applications/grant-list-query";
import { buildNextUrl, deriveListState, type ParamPatch } from "@/lib/hooks/list-params-url";

export interface GrantListParams {
  /** The request for the current URL (the person search only for a viewer with `user:read`). */
  params: ApplicationGrantPageParams;
  /** The search text in the URL, for seeding the box. */
  q: string;
  setStatus: (status: ApplicationGrantStatus) => void;
  setLevel: (selection: string) => void;
  setQ: (q: string) => void;
  setOffset: (offset: number) => void;
  clearFilters: () => void;
}

/**
 * The Access tab's status, level, search and page, kept in the URL (#1660) so a filtered view can be
 * linked and survives a reload. Derived with the shared `deriveListState` and written with
 * `buildNextUrl` through `history.replaceState`, like the record page's own `?tab=` (`useRecordTab`):
 * the App Router syncs it into `useSearchParams` without re-running the page's server prefetch, which a
 * `router.replace` would do on every keystroke and page turn.
 *
 * Every setter reads `window.location` when it runs, so two writes in one handler (the tab, then the
 * status) never clobber each other, and the setters keep a stable identity for the search box's
 * debounced callback.
 */
export function useGrantListParams({
  canSearchPeople,
}: {
  canSearchPeople: boolean;
}): GrantListParams {
  const searchParams = useSearchParams();
  const pathname = usePathname();

  const state = useMemo(() => deriveListState(searchParams, GRANT_LIST_OPTIONS), [searchParams]);
  const params = useMemo(
    () => deriveGrantPageParams(state, { canSearchPeople }),
    [state, canSearchPeople],
  );

  const commit = useCallback(
    (patch: ParamPatch) => {
      const current = window.location.search;
      const next = buildNextUrl(current, pathname, patch);
      if (next === buildNextUrl(current, pathname, {})) return;
      window.history.replaceState(null, "", next);
    },
    [pathname],
  );

  const setStatus = useCallback(
    (status: ApplicationGrantStatus) => commit(grantStatusPatch(status)),
    [commit],
  );
  const setLevel = useCallback((selection: string) => commit(grantLevelPatch(selection)), [commit]);
  // A settle that repeats the current search is not a new search: it must not reset the page.
  const setQ = useCallback(
    (q: string) => {
      const current = new URLSearchParams(window.location.search).get("q") ?? "";
      if (q.trim() === current) return;
      commit(grantSearchPatch(q));
    },
    [commit],
  );
  const setOffset = useCallback((offset: number) => commit(grantOffsetPatch(offset)), [commit]);
  const clearFilters = useCallback(() => commit(clearGrantFiltersPatch()), [commit]);

  return { params, q: state.q, setStatus, setLevel, setQ, setOffset, clearFilters };
}
