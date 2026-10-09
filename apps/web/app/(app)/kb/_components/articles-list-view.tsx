"use client";

import {
  BookOpenIcon,
  ClockIcon,
  FunnelIcon,
  LinkIcon,
  PencilSquareIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import {
  type ArticleHit,
  type ArticleLinkedTo,
  type ArticleListSort,
  type ArticleStatus,
  type Folder,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { ActiveFilters, ClearFiltersLink } from "@/components/active-filters";
import { ApplicationMultiSelect } from "@/components/application-multi-select";
import { AssetMultiSelect } from "@/components/asset-multi-select";
import { EmptyState } from "@/components/empty-state";
import {
  MultiSelectFilter,
  type MultiSelectOption,
} from "@/components/multi-select-filter";
import { PageHeader } from "@/components/page-header";
import { ErrorState, Pagination } from "@/components/resource-table";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { useApplication } from "@/lib/api/hooks/use-applications";
import type { ArticleFilters } from "@/lib/api/endpoints/articles";
import {
  useArticles,
  useArticleStatusCounts,
} from "@/lib/api/hooks/use-articles";
import { useAsset } from "@/lib/api/hooks/use-assets";
import { useSearch } from "@/lib/api/hooks/use-search";
import { useCan } from "@/lib/hooks/use-permissions";
import { useListParams } from "@/lib/hooks/use-list-params";
import { useRecentArticles } from "@/lib/hooks/use-recent-articles";
import {
  type KbBrowseMode,
  type KbStatusSegment,
  kbBrowseMode,
  kbNarrowedBeyondView,
  kbSortParam,
  parseIncludeSubfolders,
  parseKbSort,
  statusSegment,
  statusValuesFor,
} from "@/lib/utils/kb-browse";
import { articleFolderTrail } from "@/lib/utils/kb-reading";
import { resolveKbSearchMode } from "@/lib/utils/kb-search";
import { singleCategoryId } from "@/lib/utils/kb-shell-route";
import { type FolderIndex, useFolderIndex } from "../_lib/use-folder-index";
import { ArticleHitRow } from "./article-row";
import {
  ArticleTable,
  ArticleTableSkeleton,
  RecentArticleTable,
} from "./article-table";
import {
  KbCreateActions,
  KbSearchBar,
  SortMenu,
  StatusSegmented,
} from "./kb-browse-controls";
import { FolderHeader, SubfolderChips } from "./folder-header";
import { KbFolderCards, KbHomeHeader } from "./kb-home";

/** The two link-target kinds, as multi-select values (#198) — the data model has exactly these. */
const LINKED_TO_VALUES = [
  "asset",
  "application",
] as const satisfies readonly ArticleLinkedTo[];

/** Maps a link-target kind to its translation subkey (keeps the map exhaustive). */
const LINKED_TO_LABEL_KEY: Record<ArticleLinkedTo, string> = {
  asset: "assets",
  application: "applications",
};

/** Per-index hit cap for the strong Meili body search (the API clamps to 1..50). */
const SEARCH_LIMIT = 50;

/**
 * Filter param defaults — every key here is a server-side filter routed through the URL by
 * `useListParams`. `status`, `categoryId`, `linkedTo`, `assetId` and `applicationId` are
 * **multi-select** (#198/#213): comma-encoded lists read/written via `getFilterValues` /
 * `setFilterValues`, `""` meaning inactive. `linked` flips to `"only"` to keep just linked articles
 * (ADR-0042); any selected `linkedTo`, `assetId` or `applicationId` also implies it.
 *
 * `sort`, `includeSubfolders` and `view` (#1539) are deliberately NOT declared here: they describe how
 * the list is shown, not what it is narrowed to, so "Clear filters" keeps them. They are written with
 * `setFilters`, which accepts any key.
 */
const FILTER_DEFAULTS = {
  status: "",
  categoryId: "",
  linked: "ALL",
  linkedTo: "",
  assetId: "",
  applicationId: "",
} as const;

/**
 * The Knowledge Base browse page (#1106 Phase 3, redesigned in #1539). One client view whose layout
 * follows the URL (`kbBrowseMode`), so the rail, the page and a deep link always agree:
 *
 *  - **home** (All articles): a compact header with one stats line, the search box, the root-folder
 *    cards, then the article table under a status segmented control, a Sort menu and Filters;
 *  - **view** (My drafts, Linked): a compact view header, the search box and the same table;
 *  - **folder** (one `categoryId`): breadcrumb, the folder header card with its facts and actions, the
 *    sub-folder chips, then the folder's articles (the Folder column hidden) with "Include subfolders";
 *  - **search**: the strong Meilisearch body search (folder-access filtered server-side), degrading to
 *    the server title/excerpt filter when the engine is unavailable;
 *  - **recent**: this browser's recently opened articles.
 */
export function ArticlesListView() {
  const searchParams = useSearchParams();
  const mode = kbBrowseMode(searchParams);
  return mode === "recent" ? <RecentView /> : <BrowseView mode={mode} />;
}

/** The search box wired to the URL `q` (a new search resets paging). */
function UrlSearchBar() {
  const { q, setQ } = useListParams();
  return <KbSearchBar value={q} onSearch={setQ} />;
}

/**
 * The Recent view's search box. A search covers the whole KB, not this browser's list, so it leaves the
 * view: it lands on `/kb?q=…` and the rail stops highlighting Recent while global results show.
 */
function RecentSearchBar() {
  const router = useRouter();
  return (
    <KbSearchBar
      value=""
      onSearch={(query) => {
        const trimmed = query.trim();
        if (trimmed) router.push(`/kb?${new URLSearchParams({ q: trimmed }).toString()}`);
      }}
    />
  );
}

function BrowseView({ mode }: { mode: Exclude<KbBrowseMode, "recent"> }) {
  const t = useTranslations("kb");
  const searchParams = useSearchParams();
  const index = useFolderIndex();
  const {
    q,
    offset,
    limit,
    filters,
    setQ,
    setFilterValues,
    setFilters,
    getFilterValues,
    setOffset,
    clearFilters,
  } = useListParams({ filters: FILTER_DEFAULTS });

  const sort = parseKbSort(searchParams.get("sort"));
  const statusValues = getFilterValues("status") as ArticleStatus[];
  const categoryValues = getFilterValues("categoryId");
  const linkedToValues = getFilterValues("linkedTo") as ArticleLinkedTo[];
  const assetIdValues = getFilterValues("assetId");
  const applicationIdValues = getFilterValues("applicationId");
  const linkedOnly =
    filters.linked === "only" ||
    linkedToValues.length > 0 ||
    assetIdValues.length > 0 ||
    applicationIdValues.length > 0;

  const folderId = mode === "folder" ? singleCategoryId(searchParams.get("categoryId")) : null;
  const folder = folderId ? index.folderById.get(folderId) : undefined;
  const hasSubfolders = folderId ? (index.childrenById.get(folderId)?.length ?? 0) > 0 : false;
  const includeSubfolders =
    mode === "folder" && parseIncludeSubfolders(searchParams.get("includeSubfolders"));

  // The STRONG search (#1106 Phase 3): Meilisearch body full-text via the shared cross-entity rail
  // (ADR-0035), scoped to articles and folder-access filtered SERVER-side.
  const searching = mode === "search";
  const searchQuery = useSearch({
    q,
    entities: ["articles"],
    limit: SEARCH_LIMIT,
    enabled: searching,
  });
  const searchMode = resolveKbSearchMode({
    searching,
    hasSearchData: searchQuery.data !== undefined,
    degraded: searchQuery.data?.degraded === true,
    searchErrored: searchQuery.isError,
  });
  const fallbackActive = searchMode === "fallback";

  // The list scope minus status and paging — shared by the list read and the segment counts.
  const linkedScope: Pick<ArticleFilters, "linked" | "linkedTo" | "assetId" | "applicationId"> = {
    linked: linkedOnly ? "only" : undefined,
    linkedTo: linkedOnly && linkedToValues.length > 0 ? linkedToValues : undefined,
    assetId: linkedOnly && assetIdValues.length > 0 ? assetIdValues : undefined,
    applicationId:
      linkedOnly && applicationIdValues.length > 0 ? applicationIdValues : undefined,
  };
  const scope: Omit<ArticleFilters, "status" | "limit" | "offset"> = {
    // In the degraded fallback the search must be GLOBAL — matching the strong Meili search (which is
    // never folder-scoped) — so the same query returns the same scope regardless of engine health.
    categoryId: fallbackActive ? undefined : categoryValues.length > 0 ? categoryValues : undefined,
    includeSubfolders: includeSubfolders && !fallbackActive ? true : undefined,
    ...linkedScope,
  };

  // The browse list AND the degraded fallback both ride this read. With no URL params its key is
  // byte-identical to the one `kb/page.tsx` prefetches (every inactive filter is `undefined`).
  const {
    data: page,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useArticles({
    q: fallbackActive ? q || undefined : undefined,
    status: statusValues.length > 0 ? statusValues : undefined,
    ...scope,
    sort: kbSortParam(sort),
    limit,
    offset,
  });
  const counts = useArticleStatusCounts(scope, !searching);

  // Toggling "Linked only" writes linked + every narrowing key in ONE navigation (#217).
  const setLinkedOnly = (next: boolean) => {
    setFilters({
      linked: next ? "only" : FILTER_DEFAULTS.linked,
      linkedTo: [],
      assetId: [],
      applicationId: [],
    });
  };

  // Inside a folder, "clear" keeps the folder (it is the page, not a filter); elsewhere it clears all.
  const clearNarrowing =
    mode === "folder"
      ? () =>
          setFilters({
            status: [],
            linked: FILTER_DEFAULTS.linked,
            linkedTo: [],
            assetId: [],
            applicationId: [],
          })
      : clearFilters;

  const removeValue = (name: string, values: string[], value: string) =>
    setFilterValues(
      name,
      values.filter((v) => v !== value),
    );

  // One dismissible chip per active advanced filter. Status is shown by the segmented control and the
  // open folder by its header, so neither is chipped; a multi-folder selection (a deep link) still is.
  const chips = [
    ...(mode === "folder"
      ? []
      : categoryValues.map((categoryId) => ({
          key: `categoryId:${categoryId}`,
          label: t("filters.chipCategory", {
            value: index.folderById.get(categoryId)?.name ?? t("list.uncategorized"),
          }),
          onClear: () => removeValue("categoryId", categoryValues, categoryId),
        }))),
    ...linkedToValues.map((kind) => ({
      key: `linkedTo:${kind}`,
      label: t("filters.chipLinkedTo", {
        value: t(`filters.linkedToLabel.${LINKED_TO_LABEL_KEY[kind]}`),
      }),
      onClear: () => removeValue("linkedTo", linkedToValues, kind),
    })),
    ...assetIdValues.map((assetId) => ({
      key: `assetId:${assetId}`,
      label: <AssetChipLabel assetId={assetId} />,
      onClear: () => removeValue("assetId", assetIdValues, assetId),
    })),
    ...applicationIdValues.map((applicationId) => ({
      key: `applicationId:${applicationId}`,
      label: <ApplicationChipLabel applicationId={applicationId} />,
      onClear: () => removeValue("applicationId", applicationIdValues, applicationId),
    })),
    ...(linkedOnly &&
    linkedToValues.length === 0 &&
    assetIdValues.length === 0 &&
    applicationIdValues.length === 0
      ? [{ key: "linked", label: t("filters.linkedOnly"), onClear: () => setLinkedOnly(false) }]
      : []),
  ];

  // The count on the "Filters ▾" trigger: the linked narrowing (status lives on the segmented control).
  const advancedCount =
    linkedToValues.length +
    assetIdValues.length +
    applicationIdValues.length +
    (linkedOnly &&
    linkedToValues.length === 0 &&
    assetIdValues.length === 0 &&
    applicationIdValues.length === 0
      ? 1
      : 0);

  const linkedToOptions: MultiSelectOption[] = LINKED_TO_VALUES.map((kind) => ({
    value: kind,
    label: t(`filters.linkedToLabel.${LINKED_TO_LABEL_KEY[kind]}`),
  }));

  // Inside a folder with "Include subfolders": name the sub-folder (relative to the open folder) an
  // article lives in, so the flattened list still says where each one is.
  const subfolderOf = useMemo(() => {
    if (!folderId || !includeSubfolders) return undefined;
    return (categoryId: string) => {
      if (categoryId === folderId) return null;
      const trail = articleFolderTrail(categoryId, index.folders as Folder[]);
      const at = trail.findIndex((step) => step.id === folderId);
      const below = at >= 0 ? trail.slice(at + 1) : trail;
      return below.map((step) => step.name).join(" / ") || null;
    };
  }, [folderId, includeSubfolders, index.folders]);

  const articles = page?.items ?? [];
  const total = page?.total ?? 0;

  const filterPopover = (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <FunnelIcon />
          {t("filters.filtersButton")}
          {advancedCount > 0 ? (
            <span className="ml-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-medium text-primary-foreground tabular-nums">
              {advancedCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-4">
        {/* The "runbooks for THIS asset/app" flow (#213) lives in the asset/application pickers. */}
        <div className="space-y-2">
          <Label htmlFor="kb-linked-only" className="flex cursor-pointer items-center gap-2">
            <Switch id="kb-linked-only" checked={linkedOnly} onCheckedChange={setLinkedOnly} />
            {t("filters.linkedOnly")}
          </Label>
          {linkedOnly ? (
            <div className="space-y-2 border-l pl-3">
              <MultiSelectFilter
                label={t("filters.linkedToLabelName")}
                options={linkedToOptions}
                selected={linkedToValues}
                onChange={(next) => setFilterValues("linkedTo", next)}
                className="w-full"
              />
              <AssetMultiSelect
                selected={assetIdValues}
                onChange={(next) => setFilterValues("assetId", next)}
                className="w-full"
              />
              <ApplicationMultiSelect
                selected={applicationIdValues}
                onChange={(next) => setFilterValues("applicationId", next)}
                className="w-full"
              />
            </div>
          ) : null}
        </div>
        {advancedCount > 0 ? <ClearFiltersLink onClick={clearNarrowing} /> : null}
      </PopoverContent>
    </Popover>
  );

  return (
    <div className="space-y-6">
      {mode === "folder" ? (
        folder ? (
          <FolderHeader folder={folder} index={index} includeSubfolders={includeSubfolders} />
        ) : (
          <MissingFolderHeader loaded={index.loaded} />
        )
      ) : mode === "view" ? (
        <ViewHeader linked={linkedOnly} />
      ) : (
        <KbHomeHeader folderCount={index.folders.length} />
      )}

      {mode === "folder" ? null : <UrlSearchBar />}

      {mode === "home" ? <KbFolderCards index={index} /> : null}
      {mode === "folder" && folderId ? <SubfolderChips folderId={folderId} index={index} /> : null}

      {searching && searchMode === "search" ? (
        <SearchResults
          hits={searchQuery.data?.articles?.hits ?? []}
          total={searchQuery.data?.articles?.total ?? 0}
          query={q}
          isFetching={searchQuery.isFetching}
          onClear={() => setQ("")}
          index={index}
        />
      ) : (
        <section aria-labelledby="kb-articles-heading" className="space-y-3">
          {searching ? (
            // Degraded fallback (#370): Meili is unavailable / not yet reindexed — the server
            // title+excerpt filter answers instead, and a quiet note keeps it honest.
            <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              {t("search.degradedNote")}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h2
              id="kb-articles-heading"
              className="mr-auto text-xs font-semibold tracking-wide text-muted-foreground uppercase"
            >
              {mode === "folder" ? t("folderView.listTitle") : t("home.articlesTitle")}
            </h2>
            {searching ? null : (
              <>
                <StatusSegmented
                  value={statusSegment(statusValues)}
                  onChange={(next: KbStatusSegment) =>
                    setFilterValues("status", statusValuesFor(next))
                  }
                  counts={counts}
                />
                {mode === "folder" && hasSubfolders ? (
                  <Label
                    htmlFor="kb-include-subfolders"
                    className="flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[0.8rem] ring-1 ring-foreground/10"
                  >
                    {t("folderView.includeSubfolders")}
                    <Switch
                      id="kb-include-subfolders"
                      checked={includeSubfolders}
                      onCheckedChange={(next) =>
                        setFilters({ includeSubfolders: next ? "true" : "" })
                      }
                    />
                  </Label>
                ) : null}
                <SortMenu
                  value={sort}
                  onChange={(next: ArticleListSort) =>
                    setFilters({ sort: next === "updated" ? "" : next })
                  }
                />
                {filterPopover}
              </>
            )}
          </div>

          <ActiveFilters chips={chips} onClearAll={clearNarrowing} />

          {isLoading ? (
            <ArticleTableSkeleton />
          ) : isError ? (
            <ErrorState title={t("list.errorTitle")} onRetry={() => refetch()} error={error} />
          ) : total === 0 ? (
            <EmptyList
              mode={mode}
              filtered={kbNarrowedBeyondView(searchParams)}
              onClear={searching ? () => setQ("") : clearNarrowing}
            />
          ) : (
            <>
              <ArticleTable
                articles={articles}
                folderOf={index.folderOf}
                showFolder={mode !== "folder"}
                subfolderOf={subfolderOf}
              />
              <Pagination
                total={total}
                limit={limit}
                offset={offset}
                itemCount={articles.length}
                onOffsetChange={setOffset}
                isFetching={isFetching}
              />
            </>
          )}
        </section>
      )}
    </div>
  );
}

/** The compact header of the My drafts / Linked views. */
function ViewHeader({ linked }: { linked: boolean }) {
  const t = useTranslations("kb");
  return (
    <PageHeader
      title={linked ? t("views.linked.title") : t("views.drafts.title")}
      pillar="knowledge"
      icon={linked ? LinkIcon : PencilSquareIcon}
      subtitle={linked ? t("views.linked.subtitle") : t("views.drafts.subtitle")}
      actions={<KbCreateActions />}
    />
  );
}

/** A folder id that is not (or not yet) in the live list: still loading, deleted, or never visible. */
function MissingFolderHeader({ loaded }: { loaded: boolean }) {
  const t = useTranslations("kb");
  if (!loaded) return null;
  return (
    <PageHeader
      title={t("folderView.missingTitle")}
      pillar="knowledge"
      icon={BookOpenIcon}
      subtitle={t("folderView.missingSubtitle")}
    />
  );
}

/** The empty list for each layout: no articles at all, an empty folder, or nothing matching. */
function EmptyList({
  mode,
  filtered,
  onClear,
}: {
  mode: Exclude<KbBrowseMode, "recent">;
  filtered: boolean;
  onClear: () => void;
}) {
  const t = useTranslations("kb");
  const canWrite = useCan("article:write");
  if (mode === "search" || filtered) return <NoMatches onClear={onClear} />;
  if (mode === "folder") {
    return (
      <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
        {t("list.noArticlesInFolder")}
      </p>
    );
  }
  if (mode === "view") {
    return (
      <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
        {t("views.empty")}
      </p>
    );
  }
  return (
    <EmptyState
      icon={BookOpenIcon}
      pillar="knowledge"
      title={t("list.emptyTitle")}
      description={t("list.emptyDescription")}
      action={canWrite ? { label: t("list.emptyAction"), href: "/kb/new" } : undefined}
    />
  );
}

/** The Meili body-search result list (top matches, folder-access filtered server-side). */
function SearchResults({
  hits,
  total,
  query,
  isFetching,
  onClear,
  index,
}: {
  hits: ArticleHit[];
  total: number;
  query: string;
  isFetching: boolean;
  onClear: () => void;
  index: FolderIndex;
}) {
  const t = useTranslations("kb");
  if (hits.length === 0) {
    return isFetching ? <ArticleTableSkeleton /> : <NoMatches onClear={onClear} />;
  }
  return (
    <section aria-labelledby="kb-search-heading" className="space-y-2">
      <h2 id="kb-search-heading" className="px-1 text-xs text-muted-foreground tabular-nums">
        {total > hits.length
          ? t("search.topResults", { shown: hits.length, total })
          : t("search.resultCount", { count: total })}
      </h2>
      <ul className="divide-y divide-border overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        {hits.map((hit) => (
          <li key={hit.id}>
            <ArticleHitRow
              hit={hit}
              query={query}
              folder={
                hit.categoryId && index.folderById.has(hit.categoryId)
                  ? index.folderOf(hit.categoryId)
                  : null
              }
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The "no articles match" state with a clear-search/filters link. */
function NoMatches({ onClear }: { onClear: () => void }) {
  const t = useTranslations("kb");
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-16 text-center text-sm text-muted-foreground">
      <span>{t("list.noMatchFilters")}</span>
      <ClearFiltersLink onClick={onClear} />
    </div>
  );
}

/**
 * The Recent view (#1539): the articles this viewer opened in this browser, newest first, from
 * `localStorage` only — nothing is fetched. "Clear" forgets the list.
 */
function RecentView() {
  const t = useTranslations("kb");
  const index = useFolderIndex();
  const { items, clear, ready } = useRecentArticles();

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("views.recent.title")}
        pillar="knowledge"
        icon={ClockIcon}
        subtitle={t("views.recent.subtitle")}
        actions={
          items.length > 0 ? (
            <Button variant="outline" onClick={clear}>
              <XMarkIcon />
              {t("views.recent.clear")}
            </Button>
          ) : null
        }
      />
      <RecentSearchBar />
      {items.length > 0 ? (
        <RecentArticleTable
          items={items}
          folderOf={(categoryId) =>
            categoryId && index.folderById.has(categoryId) ? index.folderOf(categoryId) : null
          }
        />
      ) : ready ? (
        <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          {t("views.recent.empty")}
        </p>
      ) : (
        <ArticleTableSkeleton />
      )}
    </div>
  );
}

/**
 * The label for a selected-asset filter chip (#213). Resolves the asset's name by id (`useAsset`) so a
 * selection that has paged out of the current asset search still shows its name; falls back to the raw
 * id while the lookup is in flight or if the asset is gone.
 */
function AssetChipLabel({ assetId }: { assetId: string }) {
  const t = useTranslations("kb");
  const { data: asset } = useAsset(assetId);
  return <>{t("filters.chipAsset", { value: asset?.name ?? assetId })}</>;
}

/** The label for a selected-application filter chip (#213). Resolves by id via `useApplication`. */
function ApplicationChipLabel({ applicationId }: { applicationId: string }) {
  const t = useTranslations("kb");
  const { data: application } = useApplication(applicationId);
  return (
    <>
      {t("filters.chipApplication", {
        value: application?.name ?? applicationId,
      })}
    </>
  );
}
