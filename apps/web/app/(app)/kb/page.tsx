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
import Link from "next/link";
import { useState } from "react";
import { ActiveFilters, ClearFiltersLink } from "@/components/active-filters";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { ErrorState, Pagination } from "@/components/resource-table";
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useArticleCategories } from "@/lib/api/hooks/use-article-categories";
import { useArticles } from "@/lib/api/hooks/use-articles";
import { useUsers } from "@/lib/api/hooks/use-users";
import { useCan } from "@/lib/hooks/use-permissions";
import { useListParams } from "@/lib/hooks/use-list-params";
import { ArticleCard } from "./_components/article-card";
import { ImportArticleDialog } from "./_components/import-article-dialog";

type StatusFilter = "ALL" | ArticleStatus;
type LinkedToFilter = "ALL" | ArticleLinkedTo;

/**
 * Filter param defaults — every key here is a server-side filter routed through the URL by
 * `useListParams`. `linked` flips to `"only"` to keep just linked articles (ADR-0042) and
 * `linkedTo` narrows that to a single target kind; both default to `"ALL"` (the inactive
 * sentinel) so they're omitted from the URL and the server query until set.
 */
const FILTER_DEFAULTS = {
  status: "ALL",
  categoryId: "ALL",
  linked: "ALL",
  linkedTo: "ALL",
} as const;

const STATUS_LABEL: Record<StatusFilter, string> = {
  ALL: "All",
  DRAFT: "Drafts",
  PUBLISHED: "Published",
};

const LINKED_TO_LABEL: Record<LinkedToFilter, string> = {
  ALL: "Any target",
  asset: "Assets",
  application: "Applications",
};

export default function KnowledgeBasePage() {
  // New article + Import both create an article, so they gate on article:write.
  const canWrite = useCan("article:write");
  const {
    q,
    offset,
    limit,
    filters,
    setQ,
    setFilter,
    setOffset,
    clearFilters,
    filtersActive,
  } = useListParams({ filters: FILTER_DEFAULTS });

  const statusFilter = filters.status as StatusFilter;
  const categoryFilter = filters.categoryId;
  const linkedOnly = filters.linked === "only";
  const linkedToFilter = filters.linkedTo as LinkedToFilter;

  const [importOpen, setImportOpen] = useState(false);

  const { data: page, isLoading, isFetching, isError, error, refetch } =
    useArticles({
      q: q || undefined,
      status: statusFilter === "ALL" ? undefined : statusFilter,
      categoryId: categoryFilter === "ALL" ? undefined : categoryFilter,
      linked: linkedOnly ? "only" : undefined,
      // linkedTo is only meaningful alongside linked=only; never send it on its own.
      linkedTo:
        linkedOnly && linkedToFilter !== "ALL" ? linkedToFilter : undefined,
      limit,
      offset,
    });
  const { data: categories } = useArticleCategories();
  const { data: users } = useUsers();

  const articles = page?.items;

  const categoryName = (id: string) =>
    categories?.find((category) => category.id === id)?.name ?? "Uncategorized";
  const authorOf = (id: string) =>
    users?.find((candidate) => candidate.id === id);

  const total = page?.total ?? 0;
  const isEmpty = total === 0;

  // Toggling "Linked only" off also clears any linkedTo narrowing (it's meaningless alone).
  const setLinkedOnly = (next: boolean) => {
    setFilter("linked", next ? "only" : FILTER_DEFAULTS.linked);
    if (!next) setFilter("linkedTo", FILTER_DEFAULTS.linkedTo);
  };

  const chips = [
    ...(q ? [{ key: "q", label: `Search: “${q}”`, onClear: () => setQ("") }] : []),
    ...(statusFilter !== "ALL"
      ? [
          {
            key: "status",
            label: `Status: ${STATUS_LABEL[statusFilter]}`,
            onClear: () => setFilter("status", FILTER_DEFAULTS.status),
          },
        ]
      : []),
    ...(categoryFilter !== "ALL"
      ? [
          {
            key: "categoryId",
            label: `Category: ${categoryName(categoryFilter)}`,
            onClear: () => setFilter("categoryId", FILTER_DEFAULTS.categoryId),
          },
        ]
      : []),
    ...(linkedOnly
      ? [
          {
            key: "linked",
            label:
              linkedToFilter !== "ALL"
                ? `Linked to: ${LINKED_TO_LABEL[linkedToFilter]}`
                : "Linked only",
            onClear: () => setLinkedOnly(false),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Knowledge Base"
        pillar="knowledge"
        icon={BookOpenIcon}
        subtitle="Internal documentation for the team."
        actions={
          canWrite ? (
            <>
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <ArrowUpTrayIcon />
                Import
              </Button>
              <Button asChild>
                <Link href="/kb/new">
                  <PlusIcon />
                  New article
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
          label="Search articles"
          placeholder="Search by title…"
          className="sm:max-w-xs sm:flex-1"
        />
        <Select
          value={statusFilter}
          onValueChange={(value) => setFilter("status", value)}
        >
          <SelectTrigger className="sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All statuses</SelectItem>
            <SelectItem value="DRAFT">Drafts only</SelectItem>
            <SelectItem value="PUBLISHED">Published only</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={categoryFilter}
          onValueChange={(value) => setFilter("categoryId", value)}
        >
          <SelectTrigger className="sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All categories</SelectItem>
            {(categories ?? []).map((category) => (
              <SelectItem key={category.id} value={category.id}>
                {category.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Linked filter: a "Linked only" toggle, plus a target narrowing once it's on. */}
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
            Linked only
          </Label>
          {linkedOnly ? (
            <Select
              value={linkedToFilter}
              onValueChange={(value) => setFilter("linkedTo", value)}
            >
              <SelectTrigger className="sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Any target</SelectItem>
                <SelectItem value="asset">Assets</SelectItem>
                <SelectItem value="application">Applications</SelectItem>
              </SelectContent>
            </Select>
          ) : null}
        </div>
      </div>

      <ActiveFilters chips={chips} onClearAll={clearFilters} />

      {isLoading ? (
        <SkeletonCards />
      ) : isError ? (
        <ErrorState
          title="Could not load articles"
          onRetry={() => refetch()}
          error={error}
        />
      ) : isEmpty ? (
        filtersActive ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center text-sm text-muted-foreground">
            <span>No articles match your filters.</span>
            <ClearFiltersLink onClick={clearFilters} />
          </div>
        ) : (
          <EmptyState
            icon={BookOpenIcon}
            pillar="knowledge"
            title="No articles yet"
            description="Capture what your team knows — runbooks, how-tos, onboarding notes. Write your first article or import one from a file."
            action={
              canWrite
                ? { label: "Write your first article", href: "/kb/new" }
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
