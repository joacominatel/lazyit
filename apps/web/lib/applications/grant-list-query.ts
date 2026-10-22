import { type ApplicationGrantStatus, ApplicationGrantStatusSchema } from "@lazyit/shared";
import type { ApplicationGrantPageParams } from "@/lib/api/endpoints/applications";
import {
  buildFiltersPatch,
  type DerivedListState,
  type ParamPatch,
  type UseListParamsOptions,
} from "@/lib/hooks/list-params-url";

/**
 * The application Access tab's URL state (#1660): which status view, level and person search the page
 * asks the server for. Pure, so the mapping from a URL to the request (and to the export, which sends
 * the same filters, ADR-0103 §10) is tested without a router.
 *
 * URL keys, next to the record page's own `?tab=`: `status` (absent = `active`), `level` (an exact access
 * level), `noLevel=true` (only grants with no level), `q` (person search) and `offset`.
 */

export const GRANT_STATUS_FILTERS = ApplicationGrantStatusSchema.options;

export const GRANT_PAGE_SIZE = 25;

/** The API's bounds (400 beyond them); a longer value from a hand-edited URL is dropped or cut, never sent. */
export const MAX_GRANT_LEVEL_LENGTH = 100;
export const MAX_GRANT_QUERY_LENGTH = 200;

/** Level-picker values for "any level" and "no level": an access level is free text, so no real one can collide. */
export const ANY_ACCESS_LEVEL = "\u0000any";
export const NO_ACCESS_LEVEL = "\u0000none";

export const GRANT_LIST_FILTER_DEFAULTS: Record<"status" | "level" | "noLevel", string> = {
  status: "active",
  level: "",
  noLevel: "",
};

/** `deriveListState` options for the Access tab. */
export const GRANT_LIST_OPTIONS: UseListParamsOptions = {
  filters: GRANT_LIST_FILTER_DEFAULTS,
  filterValidators: { status: GRANT_STATUS_FILTERS, noLevel: ["true"] },
  defaultLimit: GRANT_PAGE_SIZE,
};

type GrantListState = Pick<DerivedListState, "q" | "offset" | "limit" | "filters">;

function statusOf(raw: string | undefined): ApplicationGrantStatus {
  const parsed = ApplicationGrantStatusSchema.safeParse(raw);
  return parsed.success ? parsed.data : "active";
}

/**
 * The request for the current URL. The person search is sent only when the viewer may search people
 * (`user:read`): without it the API answers 403, so a `?q=` in a shared link is ignored instead.
 */
export function deriveGrantPageParams(
  state: GrantListState,
  { canSearchPeople }: { canSearchPeople: boolean },
): ApplicationGrantPageParams {
  const params: ApplicationGrantPageParams = {
    status: statusOf(state.filters.status),
    limit: state.limit,
    offset: state.offset,
  };
  if (state.filters.noLevel === "true") {
    params.noAccessLevel = true;
  } else {
    const level = (state.filters.level ?? "").trim();
    if (level !== "" && level.length <= MAX_GRANT_LEVEL_LENGTH) params.accessLevel = level;
  }
  if (canSearchPeople) {
    const q = state.q.trim().slice(0, MAX_GRANT_QUERY_LENGTH).trim();
    if (q !== "") params.q = q;
  }
  return params;
}

/** True when a search or a level narrows the status view (the empty state then offers "Clear filters"). */
export function isGrantListNarrowed(params: ApplicationGrantPageParams): boolean {
  return Boolean(params.q || params.accessLevel || params.noAccessLevel);
}

/** The level picker's value for the request being made. */
export function grantLevelSelection(params: ApplicationGrantPageParams): string {
  if (params.noAccessLevel) return NO_ACCESS_LEVEL;
  return params.accessLevel ?? ANY_ACCESS_LEVEL;
}

/** Switch the status view; back to the first page. */
export function grantStatusPatch(status: ApplicationGrantStatus): ParamPatch {
  return buildFiltersPatch({ status }, GRANT_LIST_FILTER_DEFAULTS);
}

/** Pick a level (or "any" / "no level") in one write, so `level` and `noLevel` never disagree. */
export function grantLevelPatch(selection: string): ParamPatch {
  if (selection === NO_ACCESS_LEVEL) {
    return buildFiltersPatch({ level: "", noLevel: "true" }, GRANT_LIST_FILTER_DEFAULTS);
  }
  const level = selection === ANY_ACCESS_LEVEL ? "" : selection;
  return buildFiltersPatch({ level, noLevel: "" }, GRANT_LIST_FILTER_DEFAULTS);
}

/** Set the person search; a new result set, so back to the first page. */
export function grantSearchPatch(q: string): ParamPatch {
  return { q: q.trim() || undefined, offset: undefined };
}

/** Clear the search and the level, keeping the status view. */
export function clearGrantFiltersPatch(): ParamPatch {
  return { q: undefined, ...grantLevelPatch(ANY_ACCESS_LEVEL) };
}

/** Move to another page of the current view. */
export function grantOffsetPatch(offset: number): ParamPatch {
  return { offset: offset > 0 ? offset : undefined };
}
