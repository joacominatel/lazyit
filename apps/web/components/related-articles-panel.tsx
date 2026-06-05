"use client";

import {
  ArrowTopRightOnSquareIcon,
  BookOpenIcon,
} from "@heroicons/react/24/outline";
import type { ArticleListItem } from "@lazyit/shared";
import { DEFAULT_PAGE_LIMIT } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo, useState } from "react";
import { DetailPanel } from "@/components/detail-panel";
import {
  MultiSelectFilter,
  type MultiSelectOption,
} from "@/components/multi-select-filter";
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useApplicationArticles,
  useAssetArticles,
} from "@/lib/api/hooks/use-article-links";
import { useArticleCategories } from "@/lib/api/hooks/use-article-categories";

/**
 * "Related articles / Runbooks" panel for the asset and application detail pages (ADR-0042, #104).
 * Consumes the reverse lookup (`GET /assets/:id/articles` / `GET /applications/:id/articles`) — the
 * PUBLISHED articles linked to this record, returned lean (no body). The list is **server-side
 * paginated + filterable** (#220 / ADR-0030): a debounced `q` search, a category multi-select
 * (#198 `MultiSelectFilter`), and "Load more" pagination over the `Page<ArticleListItem>` envelope.
 *
 * READ-ONLY here: links are created/removed from the KB article side (the "Linked to" panel), keeping
 * a single write surface — this panel never mutates. There is intentionally **no status filter**: the
 * reverse list is always PUBLISHED-only server-side, so a status control could only ever surface
 * drafts (which are author-private and never appear here) or be a no-op — neither is wanted.
 *
 * Pass exactly one of `assetId` / `applicationId` (the record this detail page is for).
 *
 * Activated Restraint (ADR-0049): neutral `--foreground` / `--muted-foreground` surfaces; the filter
 * control composes the vendored dropdown (no new primitive) and any motion rides the dropdown's
 * CSS animations behind the global `prefers-reduced-motion` guard.
 */
export function RelatedArticlesPanel(
  props:
    | { assetId: string; applicationId?: never }
    | { applicationId: string; assetId?: never },
) {
  const t = useTranslations("shared");

  // Local view-state (panel-scoped, not URL-synced — a detail page can host several panels). `q` is
  // self-debounced by SearchInput; the category selection OR-combines (#198); `limit` grows on
  // "Load more" (offset stays 0 so the page accumulates from the top — newest-updated first).
  const [q, setQ] = useState("");
  const [categoryId, setCategoryId] = useState<string[]>([]);
  const [limit, setLimit] = useState(DEFAULT_PAGE_LIMIT);

  const filters = useMemo(
    () => ({
      q: q || undefined,
      categoryId: categoryId.length > 0 ? categoryId : undefined,
      limit,
    }),
    [q, categoryId, limit],
  );

  const assetQuery = useAssetArticles(props.assetId, filters);
  const appQuery = useApplicationArticles(props.applicationId, filters);
  const { data, isLoading, isError } = props.assetId ? assetQuery : appQuery;

  const items: ArticleListItem[] = data?.items ?? [];
  const total = data?.total ?? 0;
  const hasMore = items.length < total;
  // A search/filter is active iff the user narrowed the list — distinguishes "no links yet" (the
  // record has zero linked articles) from "no matches" (links exist but none match the filter).
  const isFiltered = q !== "" || categoryId.length > 0;

  const { data: categories } = useArticleCategories();
  const categoryOptions: MultiSelectOption[] = useMemo(
    () =>
      (categories ?? []).map((category) => ({
        value: category.id,
        label: category.name,
      })),
    [categories],
  );

  return (
    <DetailPanel title={t("relatedArticles.title")}>
      {/* Filter row: a debounced search + the category multi-select. Reset the page window whenever a
          filter changes so the user always starts at the first page of the new result set. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <SearchInput
          value={q}
          onChange={setQ}
          debounceMs={300}
          onDebouncedChange={(next) => {
            setQ(next);
            setLimit(DEFAULT_PAGE_LIMIT);
          }}
          label={t("relatedArticles.searchLabel")}
          placeholder={t("relatedArticles.searchPlaceholder")}
          className="min-w-0 flex-1"
        />
        {categoryOptions.length > 0 ? (
          <MultiSelectFilter
            label={t("relatedArticles.categoryFilterLabel")}
            options={categoryOptions}
            selected={categoryId}
            onChange={(next) => {
              setCategoryId(next);
              setLimit(DEFAULT_PAGE_LIMIT);
            }}
            align="end"
          />
        ) : null}
      </div>

      {isLoading ? (
        <div className="space-y-3" aria-hidden>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : isError ? (
        <p className="text-sm text-muted-foreground">
          {t("relatedArticles.loadError")}
        </p>
      ) : items.length === 0 ? (
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <BookOpenIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            {isFiltered
              ? t("relatedArticles.noMatches")
              : t("relatedArticles.noLinkedArticles")}
          </p>
        </div>
      ) : (
        <>
          {/* Tall lists scroll within the panel rather than pushing the page (the PR #207 feed pattern). */}
          <ul className="max-h-[calc(100svh-20rem)] divide-y overflow-y-auto">
            {items.map((article) => (
              <li
                key={article.id}
                className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <Link
                    href={`/kb/${article.slug}`}
                    className="truncate font-medium hover:underline"
                  >
                    {article.title}
                  </Link>
                  {article.excerpt && (
                    <p className="truncate text-sm text-muted-foreground">
                      {article.excerpt}
                    </p>
                  )}
                </div>
                <Button variant="ghost" size="sm" asChild>
                  <Link href={`/kb/${article.slug}`}>
                    {t("relatedArticles.view")}
                    <ArrowTopRightOnSquareIcon />
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
          {hasMore ? (
            <div className="mt-3 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLimit((current) => current + DEFAULT_PAGE_LIMIT)}
              >
                {t("relatedArticles.loadMore")}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </DetailPanel>
  );
}
