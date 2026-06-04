"use client";

import { ArrowTopRightOnSquareIcon, BookOpenIcon } from "@heroicons/react/24/outline";
import type { ArticleListItem } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DetailPanel } from "@/components/detail-panel";
import {
  useApplicationArticles,
  useAssetArticles,
} from "@/lib/api/hooks/use-article-links";

/**
 * "Related articles / Runbooks" panel for the asset and application detail pages (ADR-0042, #104).
 * Consumes the reverse lookup (`GET /assets/:id/articles` / `GET /applications/:id/articles`) — the
 * PUBLISHED articles linked to this record, returned lean (no body). Read-only here: links are
 * created/removed from the KB article side (the "Linked to" panel), keeping a single write surface.
 *
 * Pass exactly one of `assetId` / `applicationId` (the record this detail page is for).
 */
export function RelatedArticlesPanel(
  props:
    | { assetId: string; applicationId?: never }
    | { applicationId: string; assetId?: never },
) {
  const t = useTranslations("shared");
  const assetQuery = useAssetArticles(props.assetId);
  const appQuery = useApplicationArticles(props.applicationId);
  const { data, isLoading } = props.assetId ? assetQuery : appQuery;
  const articles = data ?? [];

  return (
    <DetailPanel title={t("detail.relatedArticlesTitle")}>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t("detail.loadingRunbooks")}</p>
      ) : articles.length === 0 ? (
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <BookOpenIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>{t("detail.noLinkedArticles")}</p>
        </div>
      ) : (
        <ul className="divide-y">
          {articles.map((article: ArticleListItem) => (
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
                  {t("detail.view")}
                  <ArrowTopRightOnSquareIcon />
                </Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </DetailPanel>
  );
}
