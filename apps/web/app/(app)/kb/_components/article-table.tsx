"use client";

import { DocumentTextIcon } from "@heroicons/react/24/outline";
import { LinkIcon } from "@heroicons/react/16/solid";
import type { ArticleListItem } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import type { ReactNode } from "react";
import { UserAvatar } from "@/components/user-avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { cn } from "@/lib/utils";
import type { RecentArticle } from "@/lib/utils/kb-recent";
import { RestrictionPadlock } from "./restriction-padlock";

/**
 * The KB article table (#1539) — the dense browse list as a table-like grid: Article · Folder · Author ·
 * Reading · Updated, under one column-header row. Built on CSS grid with CONTAINER queries rather than
 * viewport breakpoints, because the room it gets depends on the app sidebar and the KB rail, not on the
 * window: below `@xl` (576px of list) each row collapses to two lines with the folder under the title;
 * Author and Reading join once the list is wide enough for them. Every row is one link, so the whole
 * row is the click target and the table stays a list for assistive tech (the header row is
 * `aria-hidden`; each cell's meaning is in its text).
 *
 * Data is the lean list item (ADR-0042) — the body is never loaded.
 */

/** How a folder's access reads: PUBLIC (no padlock), its OWN rule, or INHERITED from an ancestor. */
export type FolderRestriction = "public" | "own" | "inherited";

/** What a row shows about an article's home folder. */
export interface FolderDisplay {
  /** Full path ("Servers / Linux"), or the "Uncategorized" label for a missing folder. */
  path: string;
  restriction: FolderRestriction;
  /** The restricting ancestor's name for an inherited restriction. */
  ancestorName?: string;
}

/** Column templates — one per table shape, shared by the header row and every row. */
const LAYOUT = {
  withFolder: {
    grid: "@xl:grid @xl:grid-cols-[minmax(0,1fr)_minmax(0,10rem)_6.5rem] @3xl:grid-cols-[minmax(0,1fr)_minmax(0,11rem)_minmax(0,9rem)_3.5rem_6.5rem]",
    wide: "hidden @3xl:flex",
  },
  withoutFolder: {
    grid: "@xl:grid @xl:grid-cols-[minmax(0,1fr)_6.5rem] @2xl:grid-cols-[minmax(0,1fr)_minmax(0,9rem)_3.5rem_6.5rem]",
    wide: "hidden @2xl:flex",
  },
  recent: {
    grid: "@xl:grid @xl:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_6.5rem]",
    wide: "hidden",
  },
} as const;

type LayoutKey = keyof typeof LAYOUT;

const ROW =
  "group block gap-x-4 px-3 py-2.5 outline-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset @xl:items-center";

/** The card around a table: hairline-divided rows on the card surface. */
function TableFrame({ children }: { children: ReactNode }) {
  return (
    <div className="@container overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10">
      <div className="divide-y divide-border">{children}</div>
    </div>
  );
}

/** The column-header row — visual only (`aria-hidden`); hidden while rows are stacked. */
function HeaderRow({ layout, cells }: { layout: LayoutKey; cells: { label: string; wide?: boolean; align?: "end" }[] }) {
  return (
    <div
      aria-hidden
      className={cn(
        "hidden gap-x-4 px-3 py-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase",
        LAYOUT[layout].grid,
      )}
    >
      {cells.map((cell) => (
        <span
          key={cell.label}
          className={cn(cell.wide && LAYOUT[layout].wide, "truncate")}
        >
          {cell.label}
        </span>
      ))}
    </div>
  );
}

/** The document glyph at the start of every row. */
function DocGlyph() {
  return (
    <span
      aria-hidden
      className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground @xl:mt-0"
    >
      <DocumentTextIcon className="size-4" />
    </span>
  );
}

/** The folder path with its padlock — a table cell and the stacked second line share it. */
function FolderPath({ folder, className }: { folder: FolderDisplay; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)} title={folder.path}>
      {folder.restriction !== "public" ? (
        <RestrictionPadlock
          inheritedFrom={folder.restriction === "inherited" ? (folder.ancestorName ?? "") : null}
        />
      ) : null}
      <span className="truncate">{folder.path}</span>
    </span>
  );
}

/**
 * The browse table over lean list items. `folderOf` resolves the home-folder column; pass
 * `showFolder={false}` inside a folder view, where the column would repeat the header. `subfolderOf`
 * (folder view with "Include subfolders") names the sub-folder an article lives in, shown before its
 * excerpt; it returns `null` for the open folder's own articles.
 */
export function ArticleTable({
  articles,
  folderOf,
  showFolder = true,
  subfolderOf,
}: {
  articles: ArticleListItem[];
  folderOf: (categoryId: string) => FolderDisplay;
  showFolder?: boolean;
  subfolderOf?: (categoryId: string) => string | null;
}) {
  const t = useTranslations("kb");
  const layout: LayoutKey = showFolder ? "withFolder" : "withoutFolder";
  return (
    <TableFrame>
      <HeaderRow
        layout={layout}
        cells={[
          { label: t("table.article") },
          ...(showFolder ? [{ label: t("table.folder") }] : []),
          { label: t("table.author"), wide: true },
          { label: t("table.reading"), wide: true },
          { label: t("table.updated") },
        ]}
      />
      <ul>
        {articles.map((article) => (
          <li key={article.id} className="border-t border-border first:border-t-0">
            <ArticleTableRow
              article={article}
              layout={layout}
              folder={folderOf(article.categoryId)}
              showFolder={showFolder}
              subfolder={subfolderOf?.(article.categoryId) ?? null}
            />
          </li>
        ))}
      </ul>
    </TableFrame>
  );
}

function ArticleTableRow({
  article,
  layout,
  folder,
  showFolder,
  subfolder,
}: {
  article: ArticleListItem;
  layout: LayoutKey;
  folder: FolderDisplay;
  showFolder: boolean;
  subfolder: string | null;
}) {
  const t = useTranslations("kb");
  const { relative, dateTime } = useFormatters();
  const isDraft = article.status === "DRAFT";
  const author = article.author;
  const authorName = author ? `${author.firstName} ${author.lastName}`.trim() : null;
  const isFormerMember = author?.deletedAt != null;
  const updated = (
    <span className="font-mono text-xs text-muted-foreground tabular-nums" title={dateTime(article.updatedAt)}>
      {relative(article.updatedAt)}
    </span>
  );

  return (
    <Link href={`/kb/${article.slug}`} className={cn(ROW, LAYOUT[layout].grid)}>
      {/* Article */}
      <div className="flex min-w-0 items-start gap-3 @xl:items-center">
        <DocGlyph />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-foreground">{article.title}</span>
            {isDraft ? (
              <StatusBadge tone="warning" title={t("list.draftTooltip")}>
                {t("status.draft")}
              </StatusBadge>
            ) : null}
            {article.linkCount > 0 ? (
              <span
                className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground tabular-nums"
                title={t("list.linkedTooltip", { count: article.linkCount })}
              >
                <LinkIcon className="size-3.5" aria-hidden />
                {article.linkCount}
                <span className="sr-only">{t("list.linkedTooltip", { count: article.linkCount })}</span>
              </span>
            ) : null}
          </div>

          {/* Stacked (narrow list): the folder and the date under the title. */}
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground @xl:hidden">
            {showFolder ? (
              <FolderPath folder={folder} className="min-w-0 shrink" />
            ) : subfolder ? (
              <span className="truncate">{subfolder}</span>
            ) : null}
            {showFolder || subfolder ? <span aria-hidden>·</span> : null}
            <span className="shrink-0">{updated}</span>
          </div>

          {/* Table: the summary line (sub-folder first when the folder view includes sub-folders). */}
          <div className="hidden min-w-0 truncate text-xs text-muted-foreground @xl:block">
            {subfolder ? (
              <>
                <span className="text-foreground/80">{subfolder}</span>
                <span aria-hidden> · </span>
              </>
            ) : null}
            {article.excerpt ? (
              article.excerpt
            ) : (
              <span className="italic opacity-80">{t("list.noSummary")}</span>
            )}
          </div>
        </div>
      </div>

      {/* Folder */}
      {showFolder ? (
        <FolderPath folder={folder} className="hidden text-sm text-muted-foreground @xl:flex" />
      ) : null}

      {/* Author */}
      <div className={cn("min-w-0 items-center gap-2", LAYOUT[layout].wide)}>
        {authorName ? (
          <>
            <UserAvatar
              size="sm"
              firstName={author?.firstName}
              lastName={author?.lastName}
              email={article.authorId}
              className={cn(isFormerMember && "opacity-60")}
            />
            <span className="min-w-0">
              <span className="block truncate text-sm">{authorName}</span>
              {isFormerMember ? (
                <span className="block truncate text-[11px] text-muted-foreground italic">
                  {t("list.formerMember")}
                </span>
              ) : null}
            </span>
          </>
        ) : (
          <span className="text-sm text-muted-foreground">{t("list.unknownAuthor")}</span>
        )}
      </div>

      {/* Reading */}
      <span className={cn("font-mono text-xs text-muted-foreground tabular-nums", LAYOUT[layout].wide)}>
        {article.readingMinutes > 0 ? t("list.readingShort", { minutes: article.readingMinutes }) : "—"}
      </span>

      {/* Updated */}
      <span className="hidden @xl:block">{updated}</span>
    </Link>
  );
}

/**
 * The Recent table (#1539): the same rows built from the per-browser list, which only knows slug,
 * title, home folder and when it was opened — so it shows Article · Folder · Opened and omits the
 * rest rather than inventing it.
 */
export function RecentArticleTable({
  items,
  folderOf,
}: {
  items: RecentArticle[];
  folderOf: (categoryId: string | null) => FolderDisplay | null;
}) {
  const t = useTranslations("kb");
  const { relative, dateTime } = useFormatters();
  return (
    <TableFrame>
      <HeaderRow
        layout="recent"
        cells={[
          { label: t("table.article") },
          { label: t("table.folder") },
          { label: t("table.opened") },
        ]}
      />
      <ul>
        {items.map((item) => {
          const folder = folderOf(item.categoryId);
          const opened = (
            <span className="font-mono text-xs text-muted-foreground tabular-nums" title={dateTime(item.openedAt)}>
              {relative(item.openedAt)}
            </span>
          );
          return (
            <li key={item.slug} className="border-t border-border first:border-t-0">
              <Link href={`/kb/${item.slug}`} className={cn(ROW, LAYOUT.recent.grid)}>
                <div className="flex min-w-0 items-start gap-3 @xl:items-center">
                  <DocGlyph />
                  <div className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-foreground">{item.title}</span>
                    <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground @xl:hidden">
                      {folder ? <FolderPath folder={folder} className="min-w-0 shrink" /> : null}
                      {folder ? <span aria-hidden>·</span> : null}
                      <span className="shrink-0">{opened}</span>
                    </div>
                  </div>
                </div>
                {folder ? (
                  <FolderPath folder={folder} className="hidden text-sm text-muted-foreground @xl:flex" />
                ) : (
                  <span className="hidden @xl:block" />
                )}
                <span className="hidden @xl:block">{opened}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </TableFrame>
  );
}

const SKELETON_ROW_KEYS = ["a", "b", "c", "d", "e", "f"] as const;

/** A quiet placeholder for the table while its first page loads. */
export function ArticleTableSkeleton() {
  return (
    <TableFrame>
      <ul>
        {SKELETON_ROW_KEYS.map((key) => (
          <li key={key} className="flex items-center gap-3 border-t border-border px-3 py-3 first:border-t-0">
            <Skeleton className="size-7 rounded-md" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Skeleton className="h-3 w-16" />
          </li>
        ))}
      </ul>
    </TableFrame>
  );
}
