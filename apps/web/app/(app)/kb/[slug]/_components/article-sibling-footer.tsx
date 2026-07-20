"use client";

import { ArrowLeftIcon, ArrowRightIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useArticles } from "@/lib/api/hooks/use-articles";
import { articleSiblings } from "@/lib/utils/kb-reading";

/**
 * Prev/next sibling footer for the KB reading view (#1106 Phase 2) — "← DNS records · Firewall rules →".
 * Siblings are the other articles in this article's HOME folder, derived from a wide page of that folder
 * (reusing the list hook + its cache — no new endpoint) and ordered by title so the sequence is stable
 * regardless of the list endpoint's paging order (see `articleSiblings`). Renders nothing when the
 * article is alone in its folder (or paged out of a very large one), so a lone article shows no footer.
 */

// A wide page of the folder — enough to sequence any reasonably-sized folder client-side.
const SIBLING_PAGE_SIZE = 200;

export function ArticleSiblingFooter({
  articleId,
  homeFolderId,
}: {
  articleId: string;
  homeFolderId: string;
}) {
  const t = useTranslations("kb");
  const { data: page } = useArticles({
    categoryId: [homeFolderId],
    limit: SIBLING_PAGE_SIZE,
    offset: 0,
  });

  const { prev, next } = articleSiblings(page?.items ?? [], articleId);
  if (!prev && !next) return null;

  return (
    <nav
      aria-label={t("siblings.label")}
      className="flex items-stretch justify-between gap-4 border-t border-border pt-6"
    >
      {prev ? (
        <Link
          href={`/kb/${encodeURIComponent(prev.slug)}`}
          className="group flex min-w-0 max-w-[48%] flex-col gap-0.5 rounded-lg px-1 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <ArrowLeftIcon className="size-3.5" aria-hidden />
            {t("siblings.previous")}
          </span>
          <span className="truncate text-sm font-medium group-hover:text-primary">
            {prev.title}
          </span>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link
          href={`/kb/${encodeURIComponent(next.slug)}`}
          className="group flex min-w-0 max-w-[48%] flex-col items-end gap-0.5 rounded-lg px-1 text-right focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {t("siblings.next")}
            <ArrowRightIcon className="size-3.5" aria-hidden />
          </span>
          <span className="truncate text-sm font-medium group-hover:text-primary">
            {next.title}
          </span>
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
