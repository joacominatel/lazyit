"use client";

import { DocumentTextIcon } from "@heroicons/react/24/outline";
import type { ArticleHit } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { StatusBadge } from "@/components/ui/status-badge";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { highlightSegments } from "@/lib/utils/kb-search";
import type { FolderDisplay } from "./article-table";
import { RestrictionPadlock } from "./restriction-padlock";

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

/**
 * A search-result row built from the strong Meili {@link ArticleHit} (body full-text). The hit carries
 * title/excerpt/status/slug — the indexed `content` is not retrievable (SEC-061), so the row highlights
 * the query terms in those fields — plus, since #1539, the home folder (`categoryId`) and `updatedAt`.
 * Both are nullish (a stale index document, an older API): the folder path and the date simply drop
 * out when absent. Folder-access filtering is done server-side.
 */
export function ArticleHitRow({
  hit,
  query,
  folder,
}: {
  hit: ArticleHit;
  query: string;
  /** The hit's home folder, resolved by the caller from `hit.categoryId`; `null` when unknown. */
  folder: FolderDisplay | null;
}) {
  const t = useTranslations("kb");
  const { relative, dateTime } = useFormatters();
  const isDraft = hit.status === "DRAFT";
  const updatedAt = hit.updatedAt ?? null;

  return (
    <Link
      href={`/kb/${hit.slug}`}
      className="group flex items-start gap-3 rounded-md px-3 py-2.5 outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        aria-hidden
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
      >
        <DocumentTextIcon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-foreground">
            <Highlighted text={hit.title} query={query} />
          </span>
          {isDraft ? (
            <StatusBadge tone="warning" title={t("list.draftTooltip")}>
              {t("status.draft")}
            </StatusBadge>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          {hit.excerpt ? (
            <span className="min-w-0 truncate">
              <Highlighted text={hit.excerpt} query={query} />
            </span>
          ) : null}
          {folder ? (
            <>
              {hit.excerpt ? <span aria-hidden>·</span> : null}
              <span className="flex min-w-0 items-center gap-1">
                {folder.restriction !== "public" ? (
                  <RestrictionPadlock
                    inheritedFrom={
                      folder.restriction === "inherited"
                        ? (folder.ancestorName ?? "")
                        : null
                    }
                  />
                ) : null}
                <span className="truncate">{folder.path}</span>
              </span>
            </>
          ) : null}
          {updatedAt ? (
            <>
              {hit.excerpt || folder ? <span aria-hidden>·</span> : null}
              <span
                className="shrink-0 font-mono tabular-nums"
                title={dateTime(updatedAt)}
              >
                {relative(updatedAt)}
              </span>
            </>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
