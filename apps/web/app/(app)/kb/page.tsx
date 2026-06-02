"use client";

import {
  ArrowUpTrayIcon,
  BookOpenIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import { type ArticleStatus } from "@lazyit/shared";
import Link from "next/link";
import { useState } from "react";
import { ActiveFilters, ClearFiltersLink } from "@/components/active-filters";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState, Pagination } from "@/components/resource-table";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useArticleCategories } from "@/lib/api/hooks/use-article-categories";
import { useArticles } from "@/lib/api/hooks/use-articles";
import { useUsers } from "@/lib/api/hooks/use-users";
import { useCanWrite } from "@/lib/hooks/use-permissions";
import { useListParams } from "@/lib/hooks/use-list-params";
import { formatDate } from "@/lib/utils/format";
import { ArticleStatusBadge } from "./_components/article-status-badge";
import { ImportArticleDialog } from "./_components/import-article-dialog";

type StatusFilter = "ALL" | ArticleStatus;

/** Filter param defaults. `status` and `categoryId` are both server-side filters. */
const FILTER_DEFAULTS = { status: "ALL", categoryId: "ALL" } as const;

const STATUS_LABEL: Record<StatusFilter, string> = {
  ALL: "All",
  DRAFT: "Drafts",
  PUBLISHED: "Published",
};

export default function KnowledgeBasePage() {
  const canWrite = useCanWrite();
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

  const [importOpen, setImportOpen] = useState(false);

  const { data: page, isLoading, isFetching, isError, error, refetch } =
    useArticles({
      q: q || undefined,
      status: statusFilter === "ALL" ? undefined : statusFilter,
      categoryId: categoryFilter === "ALL" ? undefined : categoryFilter,
      limit,
      offset,
    });
  const { data: categories } = useArticleCategories();
  const { data: users } = useUsers();

  const articles = page?.items;

  const categoryName = (id: string) =>
    categories?.find((category) => category.id === id)?.name ?? "Uncategorized";
  const authorName = (id: string) => {
    const user = users?.find((candidate) => candidate.id === id);
    return user ? `${user.firstName} ${user.lastName}` : "Unknown author";
  };

  const total = page?.total ?? 0;
  const isEmpty = total === 0;

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
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Knowledge Base"
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
            title="No articles yet"
            description="Write your first article or import one from a file."
            action={
              canWrite ? (
                <Button asChild>
                  <Link href="/kb/new">
                    <PlusIcon />
                    Write your first article
                  </Link>
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <ul className="space-y-3">
          {articles?.map((article) => (
            <li key={article.id}>
              <Link
                href={`/kb/${article.slug}`}
                className="block rounded-lg border p-4 transition-colors hover:bg-accent/50"
              >
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-medium">{article.title}</h2>
                  {article.status === "DRAFT" && (
                    <ArticleStatusBadge status="DRAFT" />
                  )}
                </div>
                {article.excerpt && (
                  <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                    {article.excerpt}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <Badge variant="outline">
                    {categoryName(article.categoryId)}
                  </Badge>
                  <span>{authorName(article.authorId)}</span>
                  <span aria-hidden>·</span>
                  <span className="tabular-nums">
                    Updated {formatDate(article.updatedAt)}
                  </span>
                </div>
              </Link>
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

const SKELETON_CARD_KEYS = ["a", "b", "c"] as const;

function SkeletonCards() {
  return (
    <div className="space-y-3">
      {SKELETON_CARD_KEYS.map((key) => (
        <div key={key} className="space-y-3 rounded-lg border p-4">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-40" />
        </div>
      ))}
    </div>
  );
}
