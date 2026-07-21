"use client";

import {
  ArrowUpTrayIcon,
  BookOpenIcon,
  FunnelIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import {
  type ArticleHit,
  type ArticleLinkedTo,
  type ArticleListItem,
  type ArticleStatus,
  isPublicAccessRules,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
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
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useApplication } from "@/lib/api/hooks/use-applications";
import { useArticleCategories } from "@/lib/api/hooks/use-article-categories";
import { useArticles } from "@/lib/api/hooks/use-articles";
import { useAsset } from "@/lib/api/hooks/use-assets";
import { useSearch } from "@/lib/api/hooks/use-search";
import { useCan } from "@/lib/hooks/use-permissions";
import { useListParams } from "@/lib/hooks/use-list-params";
import {
  compareFolderOrder,
  folderPathLabel,
  restrictedAncestorOf,
} from "@/lib/utils/folder-tree";
import { resolveKbSearchMode } from "@/lib/utils/kb-search";
import { kbFolderHref } from "@/lib/utils/kb-shell-route";
import {
  ArticleHitRow,
  ArticleRow,
  type FolderRestriction,
  SubFolderRow,
} from "./article-row";
import type { FolderWithRules } from "./folder-tree";
import { ImportArticleDialog } from "./import-article-dialog";

/** The two article statuses, as multi-select values (#198). */
const STATUS_VALUES = [
  "DRAFT",
  "PUBLISHED",
] as const satisfies readonly ArticleStatus[];
/** The two link-target kinds, as multi-select values (#198) — the data model has exactly these. */
const LINKED_TO_VALUES = [
  "asset",
  "application",
] as const satisfies readonly ArticleLinkedTo[];

/** Maps a status value to its translation subkey (keeps the map exhaustive). */
const STATUS_LABEL_KEY: Record<ArticleStatus, string> = {
  DRAFT: "drafts",
  PUBLISHED: "published",
};

/** Maps a link-target kind to its translation subkey (keeps the map exhaustive). */
const LINKED_TO_LABEL_KEY: Record<ArticleLinkedTo, string> = {
  asset: "assets",
  application: "applications",
};

/** Per-index hit cap for the strong Meili body search (the API clamps to 1..50). */
const SEARCH_LIMIT = 50;

/** Stable id on the inline search box so the `/` shortcut can focus it from a document-level handler. */
const SEARCH_INPUT_ID = "kb-search-input";

/**
 * Filter param defaults — every key here is a server-side filter routed through the URL by
 * `useListParams`. `status`, `categoryId`, `linkedTo`, `assetId` and `applicationId` are
 * **multi-select** (#198/#213): each holds a comma-encoded list of values, read/written via
 * `getFilterValues`/`setFilterValues`, and defaults to `""` (the inactive sentinel — omitted from the
 * URL + server query until set). `linked` flips to `"only"` to keep just linked articles (ADR-0042);
 * any selected `linkedTo` (a kind) OR `assetId`/`applicationId` (specific entities) also implies it.
 */
const FILTER_DEFAULTS = {
  status: "",
  categoryId: "",
  linked: "ALL",
  linkedTo: "",
  assetId: "",
  applicationId: "",
} as const;

export function ArticlesListView() {
  const t = useTranslations("kb");
  const tc = useTranslations("common");
  // New article + Import both create an article, so they gate on article:write.
  const canWrite = useCan("article:write");
  // The raw current query string — sub-folder rows preserve it (kbFolderHref strips q + offset), so a
  // drill-down from the content area behaves exactly like a tree pick in the shell.
  const currentSearch = useSearchParams().toString();
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
    filtersActive,
  } = useListParams({ filters: FILTER_DEFAULTS });

  // Multi-select filters (#198): each is a string[] read from / written to the comma-encoded URL param.
  const statusValues = getFilterValues("status") as ArticleStatus[];
  const categoryValues = getFilterValues("categoryId");
  const linkedToValues = getFilterValues("linkedTo") as ArticleLinkedTo[];
  // Specific-entity link filters (#213): the chosen asset / application ids.
  const assetIdValues = getFilterValues("assetId");
  const applicationIdValues = getFilterValues("applicationId");
  // "Linked only" is on when the explicit toggle is set OR any target kind (#198) OR any specific
  // entity (#213) is selected — every narrowing implies linked=only on the backend.
  const linkedOnly =
    filters.linked === "only" ||
    linkedToValues.length > 0 ||
    assetIdValues.length > 0 ||
    applicationIdValues.length > 0;

  // The folder tree (now in the persistent shell, Phase 3) shares the `categoryId` list filter: a pick
  // sets exactly one category. We read it here only to derive the current folder's sub-folder rows.
  const selectedFolderId =
    categoryValues.length === 1 ? categoryValues[0] : null;

  const [importOpen, setImportOpen] = useState(false);

  // The STRONG search (#1106 Phase 3): Meilisearch body full-text via the shared cross-entity rail
  // (ADR-0035), scoped to articles and folder-access filtered SERVER-side. This is the visible box now
  // — the old server title/excerpt filter (ADR-0021) survives only as the degraded fallback below.
  const searching = q.trim().length > 0;
  const searchQuery = useSearch({
    q,
    entities: ["articles"],
    limit: SEARCH_LIMIT,
    enabled: searching,
  });
  const mode = resolveKbSearchMode({
    searching,
    hasSearchData: searchQuery.data !== undefined,
    degraded: searchQuery.data?.degraded === true,
    searchErrored: searchQuery.isError,
  });
  const fallbackActive = mode === "fallback";

  // The browse list AND the degraded fallback both ride this server `useArticles` read. It carries the
  // query text ONLY in fallback mode (the server title/excerpt filter); in browse it's the plain
  // folder-filtered list, and while Meili is healthy its result is simply not displayed (search drives).
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
    // In the degraded fallback the search must be GLOBAL — matching the strong Meili search (which is
    // never folder-scoped) — so the same query returns the same scope regardless of engine health. Only
    // in plain browse does the selected folder scope the list.
    categoryId: fallbackActive
      ? undefined
      : categoryValues.length > 0
        ? categoryValues
        : undefined,
    linked: linkedOnly ? "only" : undefined,
    linkedTo:
      linkedOnly && linkedToValues.length > 0 ? linkedToValues : undefined,
    assetId: linkedOnly && assetIdValues.length > 0 ? assetIdValues : undefined,
    applicationId:
      linkedOnly && applicationIdValues.length > 0
        ? applicationIdValues
        : undefined,
    limit,
    offset,
  });
  const { data: categories } = useArticleCategories();

  // `/` focuses the inline search box (unless already typing in a field) — the quick way into search.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey)
        return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      )
        return;
      const input = document.getElementById(
        SEARCH_INPUT_ID,
      ) as HTMLInputElement | null;
      if (input) {
        event.preventDefault();
        input.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // --- Folder presentation (shared by the sub-folder rows + each article row's home-folder padlock) ---
  const folderById = useMemo(
    () => new Map((categories ?? []).map((f) => [f.id, f])),
    [categories],
  );
  const restrictedFolderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const folder of categories ?? []) {
      const rules = (folder as FolderWithRules).accessRules;
      if (
        !isPublicAccessRules(
          rules as Parameters<typeof isPublicAccessRules>[0],
        )
      )
        ids.add(folder.id);
    }
    return ids;
  }, [categories]);
  const parentById = useMemo(
    () => new Map((categories ?? []).map((f) => [f.id, f.parentId ?? null])),
    [categories],
  );
  const childCountById = useMemo(() => {
    const counts = new Map<string, number>();
    for (const folder of categories ?? []) {
      if (!folder.parentId) continue;
      counts.set(folder.parentId, (counts.get(folder.parentId) ?? 0) + 1);
    }
    return counts;
  }, [categories]);

  const categoryName = (id: string) =>
    folderById.get(id)?.name ?? t("list.uncategorized");

  // A folder's restriction presentation: its OWN rule wins; else the nearest restricted ancestor
  // (inherited, #414); else public. Presentation only — the API enforces access (INV-9).
  const folderRestriction = (
    folderId: string,
  ): { restriction: FolderRestriction; ancestorName?: string } => {
    if (restrictedFolderIds.has(folderId)) {
      return { restriction: "own" };
    }
    const ancestorId = restrictedAncestorOf(
      folderId,
      parentById,
      restrictedFolderIds,
    );
    if (ancestorId) {
      return { restriction: "inherited", ancestorName: categoryName(ancestorId) };
    }
    return { restriction: "public" };
  };

  // The full home-folder trail ("Servers / Linux") for an article row; falls back to Uncategorized
  // when the home folder is soft-deleted / missing from the live list.
  const folderPath = (categoryId: string) => {
    const folder = folderById.get(categoryId);
    return folder ? folderPathLabel(folder, folderById) : t("list.uncategorized");
  };

  // The selected folder's direct sub-folders, shown as subtle rows at the top of the browse list — the
  // drill-down that REPLACES the deleted FolderBrowseCard grid (#1106 Phase 3). Empty at "All articles"
  // or on a leaf; ordered exactly like the tree via the shared comparator. Only in browse mode.
  const childFolders =
    !searching && selectedFolderId && categories
      ? categories
          .filter((category) => category.parentId === selectedFolderId)
          .toSorted(compareFolderOrder)
      : [];

  const articles = page?.items;
  const total = page?.total ?? 0;
  const isEmpty = total === 0;

  const searchBlock = searchQuery.data?.articles;
  const searchHits = searchBlock?.hits ?? [];
  const searchTotal = searchBlock?.total ?? 0;

  // Toggling "Linked only" writes linked + every narrowing key in ONE navigation (#217).
  const setLinkedOnly = (next: boolean) => {
    setFilters({
      linked: next ? "only" : FILTER_DEFAULTS.linked,
      linkedTo: [],
      assetId: [],
      applicationId: [],
    });
  };

  const removeValue = (name: string, values: string[], value: string) =>
    setFilterValues(
      name,
      values.filter((v) => v !== value),
    );

  // One dismissible chip per active advanced filter (#198). `q` is NOT chipped — the prominent search
  // box owns it (and its own clear). A token-driven StatusDot carries the status hue.
  const chips = [
    ...statusValues.map((status) => ({
      key: `status:${status}`,
      label: (
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={status === "DRAFT" ? "warning" : "success"} />
          {t("filters.chipStatus", {
            value: t(`filters.statusLabel.${STATUS_LABEL_KEY[status]}`),
          })}
        </span>
      ),
      onClear: () => removeValue("status", statusValues, status),
    })),
    ...categoryValues.map((categoryId) => ({
      key: `categoryId:${categoryId}`,
      label: t("filters.chipCategory", { value: categoryName(categoryId) }),
      onClear: () => removeValue("categoryId", categoryValues, categoryId),
    })),
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
      onClear: () =>
        removeValue("applicationId", applicationIdValues, applicationId),
    })),
    ...(linkedOnly &&
    linkedToValues.length === 0 &&
    assetIdValues.length === 0 &&
    applicationIdValues.length === 0
      ? [
          {
            key: "linked",
            label: t("filters.linkedOnly"),
            onClear: () => setLinkedOnly(false),
          },
        ]
      : []),
  ];

  // The count on the "Filters ▾" trigger (advanced filters only — the search box + tree are separate).
  const advancedCount =
    statusValues.length +
    linkedToValues.length +
    assetIdValues.length +
    applicationIdValues.length +
    (linkedOnly &&
    linkedToValues.length === 0 &&
    assetIdValues.length === 0 &&
    applicationIdValues.length === 0
      ? 1
      : 0);

  // Options for the multi-select controls.
  const statusOptions: MultiSelectOption[] = STATUS_VALUES.map((status) => ({
    value: status,
    label: t(`filters.statusLabel.${STATUS_LABEL_KEY[status]}`),
    adornment: <StatusDot tone={status === "DRAFT" ? "warning" : "success"} />,
  }));
  const linkedToOptions: MultiSelectOption[] = LINKED_TO_VALUES.map((kind) => ({
    value: kind,
    label: t(`filters.linkedToLabel.${LINKED_TO_LABEL_KEY[kind]}`),
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("list.title")}
        pillar="knowledge"
        icon={BookOpenIcon}
        subtitle={t("list.subtitle")}
        actions={
          canWrite ? (
            <>
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <ArrowUpTrayIcon />
                {tc("import")}
              </Button>
              <Button asChild>
                <Link href="/kb/new">
                  <PlusIcon />
                  {t("list.newArticle")}
                </Link>
              </Button>
            </>
          ) : null
        }
      />

      {/* Search is the ONLY prominent affordance; the advanced filters fold behind "Filters ▾" (off by
          default). The visible box is the strong Meili body search; `/` focuses it, ⌘K opens the same
          scoped quick-switcher (persistent shell). */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchInput
          id={SEARCH_INPUT_ID}
          value={q}
          debounceMs={300}
          onDebouncedChange={setQ}
          label={t("list.searchLabel")}
          placeholder={t("list.searchPlaceholder")}
          className="sm:max-w-md sm:flex-1"
        />

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="justify-start sm:w-auto">
              <FunnelIcon />
              {t("filters.filtersButton")}
              {advancedCount > 0 ? (
                <span className="ml-1 inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground tabular-nums">
                  {advancedCount}
                </span>
              ) : null}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {t("filters.statusLabelName")}
              </Label>
              <MultiSelectFilter
                label={t("filters.statusLabelName")}
                options={statusOptions}
                selected={statusValues}
                onChange={(next) => setFilterValues("status", next)}
                className="w-full"
              />
            </div>

            {/* Linked filter: a "Linked only" toggle + a target narrowing once it's on. The
                "runbooks for THIS asset/app" flow (#213) lives in the asset/application pickers here. */}
            <div className="space-y-2">
              <Label
                htmlFor="kb-linked-only"
                className="flex cursor-pointer items-center gap-2"
              >
                <Switch
                  id="kb-linked-only"
                  checked={linkedOnly}
                  onCheckedChange={setLinkedOnly}
                />
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

            {advancedCount > 0 ? (
              <ClearFiltersLink onClick={clearFilters} />
            ) : null}
          </PopoverContent>
        </Popover>
      </div>

      <ActiveFilters chips={chips} onClearAll={clearFilters} />

      {/* --- The list --- */}
      {searching ? (
        mode === "search" ? (
          <SearchResults
            hits={searchHits}
            total={searchTotal}
            query={q}
            isFetching={searchQuery.isFetching}
            onClear={() => setQ("")}
          />
        ) : (
          // Degraded fallback (#370): Meili is unavailable / not yet reindexed, so we fall back to the
          // server title+excerpt filter (ADR-0021) — a quiet note keeps it honest, not "broken".
          <div className="space-y-3">
            <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              {t("search.degradedNote")}
            </p>
            {isLoading ? (
              <SkeletonRows />
            ) : isError ? (
              <ErrorState
                title={t("list.errorTitle")}
                onRetry={() => refetch()}
                error={error}
              />
            ) : isEmpty ? (
              <NoMatches onClear={() => setQ("")} />
            ) : (
              <>
                <ArticleRows
                  articles={articles ?? []}
                  folderPath={folderPath}
                  folderRestriction={folderRestriction}
                />
                <Pagination
                  total={total}
                  limit={limit}
                  offset={offset}
                  itemCount={articles?.length ?? 0}
                  onOffsetChange={setOffset}
                  isFetching={isFetching}
                />
              </>
            )}
          </div>
        )
      ) : isLoading ? (
        <SkeletonRows />
      ) : isError ? (
        <ErrorState
          title={t("list.errorTitle")}
          onRetry={() => refetch()}
          error={error}
        />
      ) : (
        <div className="space-y-2">
          {/* Sub-folder rows: the file-explorer drill-down, now as subtle rows (not a card grid). */}
          {childFolders.length > 0 ? (
            <ul className="divide-y divide-border/60">
              {childFolders.map((folder) => {
                const { restriction, ancestorName } = folderRestriction(
                  folder.id,
                );
                return (
                  <li key={folder.id}>
                    <SubFolderRow
                      name={folder.name}
                      href={kbFolderHref(currentSearch, folder.id)}
                      childCount={childCountById.get(folder.id) ?? 0}
                      articleCount={folder.articleCount}
                      restriction={restriction}
                      ancestorName={ancestorName}
                    />
                  </li>
                );
              })}
            </ul>
          ) : null}

          {isEmpty ? (
            childFolders.length > 0 ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">
                {t("list.noArticlesInFolder")}
              </p>
            ) : filtersActive ? (
              <NoMatches onClear={clearFilters} />
            ) : (
              <EmptyState
                icon={BookOpenIcon}
                pillar="knowledge"
                title={t("list.emptyTitle")}
                description={t("list.emptyDescription")}
                action={
                  canWrite
                    ? { label: t("list.emptyAction"), href: "/kb/new" }
                    : undefined
                }
              />
            )
          ) : (
            <>
              <ArticleRows
                articles={articles ?? []}
                folderPath={folderPath}
                folderRestriction={folderRestriction}
              />
              <Pagination
                total={total}
                limit={limit}
                offset={offset}
                itemCount={articles?.length ?? 0}
                onOffsetChange={setOffset}
                isFetching={isFetching}
              />
            </>
          )}
        </div>
      )}

      <ImportArticleDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}

/** The Meili body-search result list (top matches, folder-access filtered server-side). */
function SearchResults({
  hits,
  total,
  query,
  isFetching,
  onClear,
}: {
  hits: ArticleHit[];
  total: number;
  query: string;
  isFetching: boolean;
  onClear: () => void;
}) {
  const t = useTranslations("kb");
  if (hits.length === 0) {
    return isFetching ? (
      <SkeletonRows />
    ) : (
      <NoMatches onClear={onClear} />
    );
  }
  return (
    <div className="space-y-2">
      <p className="px-2 text-xs text-muted-foreground tabular-nums">
        {total > hits.length
          ? t("search.topResults", { shown: hits.length, total })
          : t("search.resultCount", { count: total })}
      </p>
      <ul className="divide-y divide-border/60">
        {hits.map((hit) => (
          <li key={hit.id}>
            <ArticleHitRow hit={hit} query={query} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A dense list of browse/fallback article rows. */
function ArticleRows({
  articles,
  folderPath,
  folderRestriction,
}: {
  articles: ArticleListItem[];
  folderPath: (categoryId: string) => string;
  folderRestriction: (folderId: string) => {
    restriction: FolderRestriction;
    ancestorName?: string;
  };
}) {
  return (
    <ul className="divide-y divide-border/60">
      {articles.map((article) => {
        const { restriction, ancestorName } = folderRestriction(
          article.categoryId,
        );
        return (
          <li key={article.id}>
            <ArticleRow
              article={article}
              folderPath={folderPath(article.categoryId)}
              restriction={restriction}
              ancestorName={ancestorName}
            />
          </li>
        );
      })}
    </ul>
  );
}

/** The "no articles match" state with a clear-search/filters link. */
function NoMatches({ onClear }: { onClear: () => void }) {
  const t = useTranslations("kb");
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center text-sm text-muted-foreground">
      <span>{t("list.noMatchFilters")}</span>
      <ClearFiltersLink onClick={onClear} />
    </div>
  );
}

const SKELETON_ROW_KEYS = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
] as const;

function SkeletonRows() {
  return (
    <ul className="divide-y divide-border/60">
      {SKELETON_ROW_KEYS.map((key) => (
        <li key={key} className="flex items-center gap-3 px-2 py-2.5">
          <Skeleton className="size-1.5 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="h-3 w-16" />
        </li>
      ))}
    </ul>
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
