"use client";

import {
  ArrowUpTrayIcon,
  BookOpenIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import {
  type ArticleLinkedTo,
  type ArticleStatus,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState } from "react";
import { ActiveFilters, ClearFiltersLink } from "@/components/active-filters";
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
import { useArticleCategories } from "@/lib/api/hooks/use-article-categories";
import { useArticles } from "@/lib/api/hooks/use-articles";
import { useUsers } from "@/lib/api/hooks/use-users";
import { useCan } from "@/lib/hooks/use-permissions";
import { useListParams } from "@/lib/hooks/use-list-params";
import { ArticleCard } from "./_components/article-card";
import { ImportArticleDialog } from "./_components/import-article-dialog";

/** The two article statuses, as multi-select values (#198). */
const STATUS_VALUES = ["DRAFT", "PUBLISHED"] as const satisfies readonly ArticleStatus[];
/** The two link-target kinds, as multi-select values (#198) — the data model has exactly these. */
const LINKED_TO_VALUES = ["asset", "application"] as const satisfies readonly ArticleLinkedTo[];

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
 * `useListParams`. `status`, `categoryId` and `linkedTo` are **multi-select** (#198): each holds a
 * comma-encoded list of values, read/written via `getFilterValues`/`setFilterValues`, and defaults
 * to `""` (the inactive sentinel — omitted from the URL + server query until set). `linked` flips to
 * `"only"` to keep just linked articles (ADR-0042); any selected `linkedTo` also implies it.
 */
const FILTER_DEFAULTS = {
  status: "",
  categoryId: "",
  linked: "ALL",
  linkedTo: "",
} as const;

export default function KnowledgeBasePage() {
  const t = useTranslations("kb");
  const tc = useTranslations("common");
  // New article + Import both create an article, so they gate on article:write.
  const canWrite = useCan("article:write");
  const {
    q,
    offset,
    limit,
    filters,
    setQ,
    setFilter,
    setFilterValues,
    getFilterValues,
    setOffset,
    clearFilters,
    filtersActive,
  } = useListParams({ filters: FILTER_DEFAULTS });

  // Multi-select filters (#198): each is a string[] read from / written to the comma-encoded URL param.
  const statusValues = getFilterValues("status") as ArticleStatus[];
  const categoryValues = getFilterValues("categoryId");
  const linkedToValues = getFilterValues("linkedTo") as ArticleLinkedTo[];
  // "Linked only" is on when the explicit toggle is set OR any target kind is selected (selecting a
  // kind implies linked=only — the backend treats multi linkedTo as linked=only).
  const linkedOnly = filters.linked === "only" || linkedToValues.length > 0;

  const [importOpen, setImportOpen] = useState(false);

  const { data: page, isLoading, isFetching, isError, error, refetch } =
    useArticles({
      q: q || undefined,
      status: statusValues.length > 0 ? statusValues : undefined,
      categoryId: categoryValues.length > 0 ? categoryValues : undefined,
      linked: linkedOnly ? "only" : undefined,
      // linkedTo is only meaningful alongside linked=only; never send it on its own.
      linkedTo:
        linkedOnly && linkedToValues.length > 0 ? linkedToValues : undefined,
      limit,
      offset,
    });
  const { data: categories } = useArticleCategories();
  const { data: users } = useUsers();

  const articles = page?.items;

  const categoryName = (id: string) =>
    categories?.find((category) => category.id === id)?.name ??
    t("list.uncategorized");
  const authorOf = (id: string) =>
    users?.find((candidate) => candidate.id === id);

  const total = page?.total ?? 0;
  const isEmpty = total === 0;

  // Toggling "Linked only" off also clears any linkedTo narrowing (it's meaningless alone).
  const setLinkedOnly = (next: boolean) => {
    setFilter("linked", next ? "only" : FILTER_DEFAULTS.linked);
    if (!next) setFilterValues("linkedTo", []);
  };

  const removeValue = (name: string, values: string[], value: string) =>
    setFilterValues(name, values.filter((v) => v !== value));

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
    // "Linked only" with no target narrowing keeps its own chip (the toggle, not a target choice).
    ...(linkedOnly && linkedToValues.length === 0
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
  const categoryOptions: MultiSelectOption[] = (categories ?? []).map(
    (category) => ({ value: category.id, label: category.name }),
  );
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
        <MultiSelectFilter
          label={t("filters.categoryLabelName")}
          options={categoryOptions}
          selected={categoryValues}
          onChange={(next) => setFilterValues("categoryId", next)}
          className="sm:w-48"
        />

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
            <MultiSelectFilter
              label={t("filters.linkedToLabelName")}
              options={linkedToOptions}
              selected={linkedToValues}
              onChange={(next) => setFilterValues("linkedTo", next)}
              className="sm:w-44"
            />
          ) : null}
        </div>
      </div>

      <ActiveFilters chips={chips} onClearAll={clearFilters} />

      {isLoading ? (
        <SkeletonCards />
      ) : isError ? (
        <ErrorState
          title={t("list.errorTitle")}
          onRetry={() => refetch()}
          error={error}
        />
      ) : isEmpty ? (
        filtersActive ? (
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
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
        <Pagination
          total={total}
          limit={page?.limit ?? limit}
          offset={page?.offset ?? offset}
          itemCount={articles?.length ?? 0}
          onOffsetChange={setOffset}
          isFetching={isFetching}
        />
      ) : null}

      <ImportArticleDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
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
