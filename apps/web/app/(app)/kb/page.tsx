"use client";

import {
  ArrowUpTrayIcon,
  BookOpenIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import {
  type ArticleLinkedTo,
  type ArticleStatus,
  isPublicAccessRules,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo, useState } from "react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useApplication } from "@/lib/api/hooks/use-applications";
import { useArticleCategories } from "@/lib/api/hooks/use-article-categories";
import { useArticles } from "@/lib/api/hooks/use-articles";
import { useAsset } from "@/lib/api/hooks/use-assets";
import { useUsers } from "@/lib/api/hooks/use-users";
import { useCan } from "@/lib/hooks/use-permissions";
import { useListParams } from "@/lib/hooks/use-list-params";
import {
  compareFolderOrder,
  restrictedAncestorOf,
} from "@/lib/utils/folder-tree";
import { ArticleCard } from "./_components/article-card";
import { FolderBrowseCard } from "./_components/folder-browse-card";
import { FolderTree, type FolderWithRules } from "./_components/folder-tree";
import { ImportArticleDialog } from "./_components/import-article-dialog";

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

export default function KnowledgeBasePage() {
  const t = useTranslations("kb");
  const tc = useTranslations("common");
  // New article + Import both create an article, so they gate on article:write.
  const canWrite = useCan("article:write");
  // ADR-0060: ADMIN-only access-rule editor affordance (the API gates writes server-side).
  const canManageSettings = useCan("settings:manage");
  // #415: ADMIN-only folder cascade-delete affordance — gated on `category:delete` (a folder is an
  // ArticleCategory). The API enforces the real boundary; this only hides/shows the "⋯ → Delete".
  const canDeleteFolder = useCan("category:delete");
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

  // The folder tree is single-select and shares the `categoryId` list filter (ADR-0059 §1): a tree
  // pick sets exactly one category; the tree highlights it only when one category is active (a
  // multi-select via the filter dropdown shows "All articles" highlighted, never a misleading single
  // node). Selecting a folder also resets to the first page.
  const selectedFolderId =
    categoryValues.length === 1 ? categoryValues[0] : null;
  const handleSelectFolder = (folderId: string | null) => {
    setFilterValues("categoryId", folderId ? [folderId] : []);
  };

  const [importOpen, setImportOpen] = useState(false);

  const {
    data: page,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useArticles({
    q: q || undefined,
    status: statusValues.length > 0 ? statusValues : undefined,
    categoryId: categoryValues.length > 0 ? categoryValues : undefined,
    linked: linkedOnly ? "only" : undefined,
    // linkedTo / assetId / applicationId are only meaningful alongside linked=only; never send them
    // on their own (the toggle being off clears them anyway).
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
  const { data: users } = useUsers();

  const articles = page?.items;

  // Restriction presentation data, shared by the folder-browse cards (#413) and mirroring the tree's
  // padlocks (#414). `restrictedFolderIds` = folders carrying their OWN non-empty rule; `parentById`
  // resolves the parent chain for inheritance. Both are PRESENTATION hints — the API enforces access.
  const restrictedFolderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const folder of categories ?? []) {
      const rules = (folder as FolderWithRules).accessRules;
      if (!isPublicAccessRules(rules as Parameters<typeof isPublicAccessRules>[0]))
        ids.add(folder.id);
    }
    return ids;
  }, [categories]);
  const parentById = useMemo(
    () =>
      new Map((categories ?? []).map((f) => [f.id, f.parentId ?? null])),
    [categories],
  );

  // The child folders of the currently-selected folder, surfaced as enterable cards in the main
  // content area so you can drill down like a file explorer (#413), not only via the left tree. The
  // tree data (`categories`) is reused — no extra fetch. Empty at "All articles" (no selection) or
  // when the selected folder is a leaf. `toSorted` (non-mutating) orders them exactly like the tree
  // via the shared comparator (order asc, nulls last; then name). Derived without a manual `useMemo`
  // so the React Compiler owns the memoization (the chained filter/sort defeats preserve-memo).
  const childFolders =
    selectedFolderId && categories
      ? categories
          .filter((category) => category.parentId === selectedFolderId)
          .toSorted(compareFolderOrder)
      : [];

  // Per-folder direct-child count, for the "N folders" line on a browse card (#413). Counts only
  // live folders already loaded for the tree — no extra fetch.
  const childCountById = useMemo(() => {
    const counts = new Map<string, number>();
    for (const folder of categories ?? []) {
      if (!folder.parentId) continue;
      counts.set(folder.parentId, (counts.get(folder.parentId) ?? 0) + 1);
    }
    return counts;
  }, [categories]);

  // Resolve a child folder's restriction presentation: its OWN rule wins; else the nearest restricted
  // ancestor (inherited, #414); else public. The ancestor name is resolved for the inherited tooltip.
  const folderRestriction = (folderId: string) => {
    if (restrictedFolderIds.has(folderId)) {
      return { restriction: "own" as const, ancestorName: undefined };
    }
    const ancestorId = restrictedAncestorOf(
      folderId,
      parentById,
      restrictedFolderIds,
    );
    if (ancestorId) {
      return {
        restriction: "inherited" as const,
        ancestorName: categoryName(ancestorId),
      };
    }
    return { restriction: "public" as const, ancestorName: undefined };
  };

  const categoryName = (id: string) =>
    categories?.find((category) => category.id === id)?.name ??
    t("list.uncategorized");
  const authorOf = (id: string) =>
    users?.find((candidate) => candidate.id === id);

  const total = page?.total ?? 0;
  const isEmpty = total === 0;

  // Toggling "Linked only" writes linked + every narrowing key in ONE navigation (#217): turning it
  // off clears the kind (linkedTo) AND the specific-entity filters (assetId/applicationId, #213)
  // atomically — all narrowing is meaningless without linked=only — so the single router.replace
  // can't re-emit a key from a stale snapshot and leave the toggle stuck on.
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

  // One dismissible chip per selected value (#198): status / category / linked-target each contribute
  // a chip per choice. A token-driven StatusDot carries the status hue (Activated Restraint — never
  // colored text on the bone canvas); category/linked chips stay neutral.
  const chips = [
    ...(q
      ? [
          {
            key: "q",
            label: t("filters.chipSearch", { query: q }),
            onClear: () => setQ(""),
          },
        ]
      : []),
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
    // Specific-entity chips (#213): each selected asset / application resolves its own name by id, so a
    // selection off the current search page still shows its label (mirrors the link-panel LinkRow).
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
    // "Linked only" with no narrowing (no kind, no specific entity) keeps its own chip (the toggle).
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

      {/* Two columns from `lg`: a folder-tree browse rail (ADR-0059 §1) + the filters/grid. The rail
          is a sticky, scrollable aside that uses the available height; below `lg` the tree stacks on
          top so it never cramps the grid on narrow screens. */}
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <aside className="lg:sticky lg:top-4 lg:w-64 lg:shrink-0">
          <div className="rounded-xl bg-card p-2 text-card-foreground ring-1 ring-foreground/10 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto">
            <FolderTree
              folders={(categories ?? []) as FolderWithRules[]}
              selectedFolderId={selectedFolderId}
              onSelect={handleSelectFolder}
              isAdmin={canManageSettings}
              canDelete={canDeleteFolder}
            />
          </div>
        </aside>

        <div className="min-w-0 flex-1 space-y-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchInput
          value={q}
          onChange={setQ}
          debounceMs={300}
          onDebouncedChange={setQ}
          label={t("list.searchLabel")}
          placeholder={t("list.searchPlaceholder")}
          className="sm:max-w-xs sm:flex-1"
        />
        <MultiSelectFilter
          label={t("filters.statusLabelName")}
          options={statusOptions}
          selected={statusValues}
          onChange={(next) => setFilterValues("status", next)}
          className="sm:w-40"
        />

        {/* The category filter dropdown was removed (#412): the folder-tree rail (left) is now the
            single browse/filter affordance — a tree pick drives the same `categoryId` filter. */}

        {/* Linked filter: a "Linked only" toggle, plus a multi-select target narrowing once it's on. */}
        <div className="flex items-center gap-2">
          <Label
            htmlFor="kb-linked-only"
            className="flex cursor-pointer items-center gap-2 whitespace-nowrap"
          >
            <Switch
              id="kb-linked-only"
              checked={linkedOnly}
              onCheckedChange={setLinkedOnly}
            />
            {t("filters.linkedOnly")}
          </Label>
          {linkedOnly ? (
            <>
              <MultiSelectFilter
                label={t("filters.linkedToLabelName")}
                options={linkedToOptions}
                selected={linkedToValues}
                onChange={(next) => setFilterValues("linkedTo", next)}
                className="sm:w-44"
              />
              {/* Specific-entity pickers (#213): narrow to particular assets / applications. Assets
                  are searched server-side (no fleet ceiling); applications are a small curated list. */}
              <AssetMultiSelect
                selected={assetIdValues}
                onChange={(next) => setFilterValues("assetId", next)}
                className="sm:w-48"
              />
              <ApplicationMultiSelect
                selected={applicationIdValues}
                onChange={(next) => setFilterValues("applicationId", next)}
                className="sm:w-48"
              />
            </>
          ) : null}
        </div>
      </div>

      <ActiveFilters chips={chips} onClearAll={clearFilters} />

      {/* #413: the selected folder's child folders, as enterable browse cards above the article grid
          — drill DOWN from the content area like a file explorer (not only via the left tree).
          Reuses the already-loaded folder data; clicking a card enters it (selects it + drives the
          categoryId filter). Always shown when present, even while the article list is loading. */}
      {childFolders.length > 0 ? (
        <section aria-label={t("folders.subfoldersLabel")}>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {childFolders.map((folder) => {
              const { restriction, ancestorName } = folderRestriction(folder.id);
              return (
                <li key={folder.id}>
                  <FolderBrowseCard
                    name={folder.name}
                    childCount={childCountById.get(folder.id) ?? 0}
                    articleCount={0}
                    restriction={restriction}
                    ancestorName={ancestorName}
                    onEnter={() => handleSelectFolder(folder.id)}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {isLoading ? (
        <SkeletonCards />
      ) : isError ? (
        <ErrorState
          title={t("list.errorTitle")}
          onRetry={() => refetch()}
          error={error}
        />
      ) : isEmpty ? (
        // A folder that only holds sub-folders (its own articles empty) is NOT "empty" — the browse
        // cards above ARE its content, so suppress the full empty state and show a quiet note instead.
        childFolders.length > 0 ? (
          <p className="px-1 text-sm text-muted-foreground">
            {t("list.noArticlesInFolder")}
          </p>
        ) : filtersActive ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center text-sm text-muted-foreground">
            <span>{t("list.noMatchFilters")}</span>
            <ClearFiltersLink onClick={clearFilters} />
          </div>
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
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {articles?.map((article) => (
            <li key={article.id}>
              <ArticleCard
                article={article}
                categoryName={categoryName(article.categoryId)}
                author={authorOf(article.authorId)}
              />
            </li>
          ))}
        </ul>
      )}

          {!isLoading && !isError && !isEmpty ? (
            // #416: drive the pager off the URL window (`limit`/`offset` from useListParams — the
            // single source of truth) rather than the envelope echo. With `keepPreviousData` the
            // previous page's envelope (offset 0) lingers for a frame while the next page resolves;
            // feeding `page.offset` made the footer (and the Next button's `offset + limit` math)
            // read from that stale page, so "Next" appeared to snap back to page 1. The URL window is
            // already authoritative and updates synchronously on the pick.
            <Pagination
              total={total}
              limit={limit}
              offset={offset}
              itemCount={articles?.length ?? 0}
              onOffsetChange={setOffset}
              isFetching={isFetching}
            />
          ) : null}
        </div>
      </div>

      <ImportArticleDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}

/**
 * The label for a selected-asset filter chip (#213). Resolves the asset's name by id (`useAsset`) so a
 * selection that has paged out of the current asset search still shows its name; falls back to the raw
 * id while the lookup is in flight or if the asset is gone. The id itself is never translated.
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

const SKELETON_CARD_KEYS = ["a", "b", "c", "d", "e", "f"] as const;

function SkeletonCards() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {SKELETON_CARD_KEYS.map((key) => (
        <div key={key} className="space-y-3 rounded-xl border p-4">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
          <div className="flex items-center justify-between gap-2 pt-3">
            <Skeleton className="h-6 w-28 rounded-full" />
            <Skeleton className="h-4 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}
