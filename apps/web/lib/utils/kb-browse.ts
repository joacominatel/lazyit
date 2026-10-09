import {
  type ArticleListSort,
  ArticleListSortSchema,
  type ArticleStatus,
} from "@lazyit/shared";
import { singleCategoryId } from "./kb-shell-route";

/**
 * Pure URL derivations for the KB browse surface (#1539): which rail view is active, which layout the
 * page renders, the sort and the include-subfolders switch, and the status segmented control. The URL
 * is the only source of truth — nothing here reads React state — so the rail, the page and a deep link
 * always agree, and the derivations are unit-tested directly (`kb-browse.test.ts`).
 */

/** The four rail views. `drafts` is `status=DRAFT`: drafts are private to their author server-side. */
export type KbView = "all" | "drafts" | "recent" | "linked";

export const KB_VIEWS = ["all", "drafts", "recent", "linked"] as const satisfies readonly KbView[];

/** The read side of `URLSearchParams` / `useSearchParams()` — all these helpers need. */
export interface KbParamsReader {
  get(name: string): string | null;
}

/** Split a comma-encoded multi-value param into distinct, non-empty values (the #198 wire shape). */
function listValues(raw: string | null): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

/** True when any linked narrowing is set — `linked=only`, a target kind, or a specific asset/app. */
export function kbLinkedActive(params: KbParamsReader): boolean {
  return (
    params.get("linked") === "only" ||
    listValues(params.get("linkedTo")).length > 0 ||
    listValues(params.get("assetId")).length > 0 ||
    listValues(params.get("applicationId")).length > 0
  );
}

/**
 * The rail view the URL describes, or `null` when a single folder is open (the rail then highlights
 * the folder instead). `view=recent` wins over everything; any linked narrowing reads as Linked; a
 * status filter of exactly DRAFT reads as My drafts; everything else that is not a folder is All.
 */
export function kbActiveView(params: KbParamsReader): KbView | null {
  if (params.get("view") === "recent") return "recent";
  if (singleCategoryId(params.get("categoryId"))) return null;
  if (kbLinkedActive(params)) return "linked";
  const status = listValues(params.get("status"));
  if (status.length === 1 && status[0] === "DRAFT") return "drafts";
  return "all";
}

/**
 * Where a rail view navigates. A view is a fresh scope: it drops the folder, the search, paging and
 * every other filter, so the rail never lands on a confusing combination.
 */
export function kbViewHref(view: KbView): string {
  switch (view) {
    case "all":
      return "/kb";
    case "drafts":
      return "/kb?status=DRAFT";
    case "recent":
      return "/kb?view=recent";
    case "linked":
      return "/kb?linked=only";
  }
}

/**
 * Which layout the browse page renders:
 *  - `search` — a query is active (the strong search drives the list);
 *  - `recent` — the per-browser recently-opened list;
 *  - `folder` — exactly one folder is open (folder header + its list);
 *  - `home`   — All articles: the stats header, the folder cards and the article table;
 *  - `view`   — My drafts or Linked: a compact view header and the table.
 */
export type KbBrowseMode = "search" | "recent" | "folder" | "home" | "view";

export function kbBrowseMode(params: KbParamsReader): KbBrowseMode {
  if ((params.get("q") ?? "").trim()) return "search";
  const view = kbActiveView(params);
  if (view === "recent") return "recent";
  if (view === null) return "folder";
  if (view === "all") return "home";
  return "view";
}

/**
 * Whether the list is narrowed BEYOND what defines the page it is on, which decides the empty state
 * ("no articles match your filters" with a way out, versus a plain "nothing here yet"). A view is
 * itself a filter (`status=DRAFT`, `linked=only`), so counting it would tell an author with no drafts
 * that their filters match nothing and offer a "Clear filters" that throws them back home.
 *
 *  - My drafts: nothing else can narrow it (a linked filter turns it into Linked) → never narrowed.
 *  - Linked: narrowed by a status, or by a target kind or a specific asset/application.
 *  - All articles and a folder: narrowed by any status or any linked filter.
 *  - Search and Recent have their own empty states and are never "narrowed" here.
 */
export function kbNarrowedBeyondView(params: KbParamsReader): boolean {
  const mode = kbBrowseMode(params);
  if (mode === "search" || mode === "recent") return false;
  const status = listValues(params.get("status"));
  const view = kbActiveView(params);
  if (view === "drafts") return false;
  if (view === "linked") {
    return (
      status.length > 0 ||
      listValues(params.get("linkedTo")).length > 0 ||
      listValues(params.get("assetId")).length > 0 ||
      listValues(params.get("applicationId")).length > 0
    );
  }
  return status.length > 0 || kbLinkedActive(params);
}

/** The default list order; written to the URL as no parameter at all. */
export const DEFAULT_KB_SORT: ArticleListSort = "updated";

/** The `sort` options in menu order. */
export const KB_SORTS = ArticleListSortSchema.options;

/** The `?sort=` value, falling back to the default for an absent or unknown (tampered) value. */
export function parseKbSort(raw: string | null | undefined): ArticleListSort {
  const parsed = ArticleListSortSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_KB_SORT;
}

/**
 * The sort to send to the API: `undefined` for the default, so the default list keeps exactly the
 * query key the server prefetches (see `kb/page.tsx`) and an older API never sees the parameter.
 */
export function kbSortParam(sort: ArticleListSort): ArticleListSort | undefined {
  return sort === DEFAULT_KB_SORT ? undefined : sort;
}

/** `?includeSubfolders=true` is the only "on" value; anything else is off. */
export function parseIncludeSubfolders(raw: string | null | undefined): boolean {
  return raw === "true";
}

/** The three positions of the status segmented control. */
export type KbStatusSegment = "all" | ArticleStatus;

/** The segment a status filter shows as: exactly one status selects it, none or both read as All. */
export function statusSegment(values: readonly string[]): KbStatusSegment {
  const distinct = [...new Set(values)];
  if (distinct.length === 1 && (distinct[0] === "DRAFT" || distinct[0] === "PUBLISHED")) {
    return distinct[0];
  }
  return "all";
}

/** The status filter values a segment writes back to the URL. */
export function statusValuesFor(segment: KbStatusSegment): ArticleStatus[] {
  return segment === "all" ? [] : [segment];
}
