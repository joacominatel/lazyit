"use client";

import {
  ArrowUpTrayIcon,
  BookOpenIcon,
  MagnifyingGlassIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import { type ArticleStatus, DEFAULT_PAGE_LIMIT } from "@lazyit/shared";
import Link from "next/link";
import { useMemo, useState } from "react";
import { EmptyState, ErrorState, Pagination } from "@/components/resource-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { formatDate } from "@/lib/utils/format";
import { ArticleStatusBadge } from "./_components/article-status-badge";
import { ImportArticleDialog } from "./_components/import-article-dialog";

type StatusFilter = "ALL" | ArticleStatus;

export default function KnowledgeBasePage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [categoryFilter, setCategoryFilter] = useState<string>("ALL");
  const [offset, setOffset] = useState(0);
  const [importOpen, setImportOpen] = useState(false);

  const debouncedSearch = useDebouncedValue(search.trim(), 300);

  const serverFilters = useMemo(
    () => ({
      q: debouncedSearch || undefined,
      status: statusFilter === "ALL" ? undefined : statusFilter,
      categoryId: categoryFilter === "ALL" ? undefined : categoryFilter,
    }),
    [debouncedSearch, statusFilter, categoryFilter],
  );

  // Reset paging to the first page whenever the filters change (a different result set). Done during
  // render rather than in an effect so the reset and the new fetch happen in one pass.
  const filterKey = JSON.stringify(serverFilters);
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    setOffset(0);
  }

  const { data: page, isLoading, isFetching, isError, error, refetch } =
    useArticles({ ...serverFilters, offset });
  const { data: categories } = useArticleCategories();
  const { data: users } = useUsers();

  const articles = page?.items;

  const categoryName = (id: string) =>
    categories?.find((category) => category.id === id)?.name ?? "Uncategorized";
  const authorName = (id: string) => {
    const user = users?.find((candidate) => candidate.id === id);
    return user ? `${user.firstName} ${user.lastName}` : "Unknown author";
  };

  const filtersActive =
    debouncedSearch !== "" || statusFilter !== "ALL" || categoryFilter !== "ALL";
  const isEmpty = (page?.total ?? 0) === 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Knowledge Base
          </h1>
          <p className="text-sm text-muted-foreground">
            Internal documentation for the team.
          </p>
        </div>
        <div className="flex gap-2">
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
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative sm:max-w-xs sm:flex-1">
          <MagnifyingGlassIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by title…"
            className="pl-8"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(value) => setStatusFilter(value as StatusFilter)}
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
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
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
          <p className="rounded-lg border border-dashed py-16 text-center text-sm text-muted-foreground">
            No articles match your filters.
          </p>
        ) : (
          <EmptyState
            icon={BookOpenIcon}
            title="No articles yet"
            description="Write your first article or import one from a file."
            action={
              <Button asChild>
                <Link href="/kb/new">
                  <PlusIcon />
                  Write your first article
                </Link>
              </Button>
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
                  <Badge variant="outline">{categoryName(article.categoryId)}</Badge>
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
          total={page?.total ?? 0}
          limit={page?.limit ?? DEFAULT_PAGE_LIMIT}
          offset={page?.offset ?? 0}
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
