"use client";

import { ChevronRightIcon, FolderIcon } from "@heroicons/react/24/outline";
import { LinkIcon, LockClosedIcon } from "@heroicons/react/16/solid";
import type { ArticleHit, ArticleListItem } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { StatusDot } from "@/components/ui/status-badge";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { cn } from "@/lib/utils";
import { highlightSegments } from "@/lib/utils/kb-search";

/**
 * The dense line-per-doc KB list rows (#1106 Phase 3) that RETIRE the old 3-column card grid. One row
 * shows what a reader scans before opening — title, folder-path, a one-line excerpt (or a highlighted
 * body-match snippet when searching), the updated date in Commit-Mono/tabular-nums, a connections
 * count, a status dot and a padlock when the home folder is restricted — at ~20+ rows/screen vs ~6
 * cards. All data is off the lean list item / search hit (ADR-0042); the row never loads the body.
 */

/** How a folder's access reads: PUBLIC (no padlock), its OWN rule, or INHERITED from an ancestor. */
export type FolderRestriction = "public" | "own" | "inherited";

/** Shared restriction padlock — mirrors the tree's affordance (presentation only; the API enforces). */
function RestrictionLock({
  restriction,
  ancestorName,
}: {
  restriction: FolderRestriction;
  ancestorName?: string;
}) {
  const t = useTranslations("kb");
  if (restriction === "own") {
    return (
      <LockClosedIcon
        className="size-3.5 shrink-0 text-warning"
        aria-label={t("access.restrictedAriaLabel")}
      />
    );
  }
  if (restriction === "inherited") {
    return (
      <LockClosedIcon
        className="size-3.5 shrink-0 text-warning/70"
        aria-label={t("access.inheritedRestrictedAriaLabel", {
          name: ancestorName ?? "",
        })}
      />
    );
  }
  return null;
}

/**
 * Render text with every query-term occurrence wrapped in a subtle `<mark>` (client highlight). The
 * segments are a stable positional split of ONE immutable string, so the array index is a valid key.
 */
function Highlighted({ text, query }: { text: string; query: string }) {
  const segments = highlightSegments(text, query);
  return (
    <>
      {segments.map((segment, i) =>
        segment.match ? (
          <mark
            key={i}
            className="rounded-[3px] bg-warning/25 px-0.5 text-foreground"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </>
  );
}

const rowClass =
  "group flex items-center gap-3 rounded-md px-2 py-2 outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring";

/**
 * A browse row (unfiltered list) built from the lean {@link ArticleListItem}. `folderPath` is the full
 * home-folder trail ("Servers / Linux"); `restriction` mirrors the tree padlock for the home folder.
 */
export function ArticleRow({
  article,
  folderPath,
  restriction,
  ancestorName,
}: {
  article: ArticleListItem;
  folderPath: string;
  restriction: FolderRestriction;
  ancestorName?: string;
}) {
  const t = useTranslations("kb");
  const { relative, date } = useFormatters();
  const isLinked = article.linkCount > 0;

  return (
    <Link href={`/kb/${article.slug}`} className={rowClass}>
      <StatusDot tone={article.status === "DRAFT" ? "warning" : "success"} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium group-hover:text-foreground">
            {article.title}
          </span>
          <RestrictionLock restriction={restriction} ancestorName={ancestorName} />
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0 truncate">{folderPath}</span>
          {article.excerpt ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{article.excerpt}</span>
            </>
          ) : null}
        </div>
      </div>

      {isLinked ? (
        <span
          className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums sm:flex"
          title={t("list.linkedTooltip", { count: article.linkCount })}
        >
          <LinkIcon className="size-3.5" />
          {article.linkCount}
        </span>
      ) : null}

      <span
        className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums"
        title={date(article.updatedAt)}
      >
        {relative(article.updatedAt)}
      </span>
    </Link>
  );
}

/**
 * A search-result row built from the strong Meili {@link ArticleHit} (body full-text). The hit carries
 * only title/excerpt/status/slug (the indexed `content` is not retrievable, SEC-061), so the row
 * highlights the query terms in those fields; folder-path/date/connections aren't on the hit and are
 * omitted (a wire field would light them up — Phase 4). Folder-access filtering is done server-side.
 */
export function ArticleHitRow({
  hit,
  query,
}: {
  hit: ArticleHit;
  query: string;
}) {
  const isDraft = hit.status === "DRAFT";
  return (
    <Link href={`/kb/${hit.slug}`} className={rowClass}>
      <StatusDot tone={isDraft ? "warning" : "success"} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium group-hover:text-foreground">
          <Highlighted text={hit.title} query={query} />
        </div>
        {hit.excerpt ? (
          <div className="truncate text-xs text-muted-foreground">
            <Highlighted text={hit.excerpt} query={query} />
          </div>
        ) : null}
      </div>
    </Link>
  );
}

/**
 * A subtle sub-folder row at the top of the browse list (#1106 Phase 3) — REPLACES the old
 * FolderBrowseCard drill-down grid (and its hardcoded `articleCount={0}` bug: no fake counts here).
 * Navigates to that folder's browse list via `href` (a preserved-filter `kbFolderHref`).
 */
export function SubFolderRow({
  name,
  href,
  childCount,
  articleCount,
  restriction,
  ancestorName,
}: {
  name: string;
  href: string;
  /** Direct sub-folder count, shown only when > 0 (real folder data — never a faked article count). */
  childCount: number;
  /**
   * Live-article count for the folder (#1106 Phase 4). A COMPUTED read from the API — `null` for a
   * folder the viewer can't read, and absent (undefined) from a legacy server. Rendered only when it
   * is a number, so the row self-heals to no count in both cases.
   */
  articleCount?: number | null;
  restriction: FolderRestriction;
  ancestorName?: string;
}) {
  const t = useTranslations("kb");
  // Any right-aligned meta (article count and/or sub-folder count)? The FIRST one gets `ml-auto`.
  const hasMeta = articleCount != null || childCount > 0;
  return (
    <Link
      href={href}
      className={cn(rowClass, "text-muted-foreground hover:text-foreground")}
    >
      <FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate font-medium">{name}</span>
      <RestrictionLock restriction={restriction} ancestorName={ancestorName} />
      {hasMeta ? (
        <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">
          {articleCount != null ? (
            <span title={t("folders.articleCount", { count: articleCount })}>
              {t("folders.articleCount", { count: articleCount })}
            </span>
          ) : null}
          {childCount > 0 ? (
            <span>{t("folders.childFolderCount", { count: childCount })}</span>
          ) : null}
        </span>
      ) : null}
      <ChevronRightIcon
        className={cn(
          "size-4 shrink-0 text-muted-foreground/60",
          hasMeta ? "ml-1.5" : "ml-auto",
        )}
        aria-hidden
      />
    </Link>
  );
}
