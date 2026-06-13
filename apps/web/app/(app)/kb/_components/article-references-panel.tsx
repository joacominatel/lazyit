"use client";

import {
  ArrowTopRightOnSquareIcon,
  DocumentTextIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { DetailPanel } from "@/components/detail-panel";
import { useArticleBacklinks } from "@/lib/api/hooks/use-article-wiki-links";

/**
 * "References" — the article↔article BACKLINKS panel on the KB article detail (ADR-0059 §4). Lists
 * every readable article whose body `[[slug]]`-references THIS one (`GET /articles/:id/backlinks`),
 * each a link to that source article.
 *
 * Deliberately DISTINCT from {@link ArticleLinksPanel} ("Linked to", ADR-0042): that panel is
 * article↔asset/application (the runbook for THIS server); this is article↔article (runbooks that
 * point HERE). Two different relations, two different tables, two different affordances — the icon
 * (a document, not a cube/grid), the heading and the empty copy all keep them apart. Read-only: the
 * edge is materialized from `[[slug]]`s in other articles' bodies, never hand-managed here.
 */
export function ArticleReferencesPanel({ articleId }: { articleId: string }) {
  const t = useTranslations("kb");
  const { data: backlinks, isLoading } = useArticleBacklinks(articleId);

  const rows = backlinks ?? [];

  return (
    <DetailPanel title={t("references.panelTitle")}>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t("references.loading")}</p>
      ) : rows.length === 0 ? (
        <div className="flex items-start gap-2 text-sm text-muted-foreground">
          <DocumentTextIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>{t("references.empty")}</p>
        </div>
      ) : (
        <ul className="divide-y">
          {rows.map((backlink) => (
            <li
              key={backlink.id}
              className="py-3 first:pt-0 last:pb-0"
            >
              <Link
                href={`/kb/${encodeURIComponent(backlink.sourceSlug)}`}
                className="flex min-w-0 items-center gap-2 font-medium hover:underline"
              >
                <DocumentTextIcon
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span className="truncate">{backlink.sourceTitle}</span>
                <ArrowTopRightOnSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </DetailPanel>
  );
}
