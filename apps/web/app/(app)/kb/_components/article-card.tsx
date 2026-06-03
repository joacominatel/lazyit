import { ClockIcon, LinkIcon } from "@heroicons/react/16/solid";
import type { ArticleListItem, User } from "@lazyit/shared";
import Link from "next/link";
import { UserAvatar } from "@/components/user-avatar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ArticleStatusBadge } from "./article-status-badge";

/**
 * One Knowledge Base article rendered as a card for the KB grid (replacing the
 * old full-width row). The whole surface links to the article detail; the body
 * surfaces the metadata a reader scans before opening: title, excerpt, status
 * (Draft/Published), category, owner (avatar + name), estimated reading time and
 * a "linked" indicator when the article points at ≥1 Asset/Application.
 *
 * `linkCount` and `readingMinutes` come straight off the lean list item
 * (ADR-0042) — the card never loads the body. `author` is resolved by the page
 * from `authorId`; when it can't be found we fall back to a neutral label.
 */
export function ArticleCard({
  article,
  categoryName,
  author,
}: {
  article: ArticleListItem;
  categoryName: string;
  /** The resolved owner/author (from `authorId`), or `undefined` when unknown. */
  author: User | undefined;
}) {
  const isLinked = article.linkCount > 0;

  return (
    <Link
      href={`/kb/${article.slug}`}
      className={cn(
        "group flex h-full flex-col rounded-xl border bg-card p-4 text-card-foreground",
        "outline-none transition-colors hover:border-foreground/20 hover:bg-accent/40",
        "focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      {/* Title + status */}
      <div className="flex items-start justify-between gap-2">
        <h2 className="min-w-0 font-medium break-words group-hover:text-foreground">
          {article.title}
        </h2>
        <ArticleStatusBadge status={article.status} className="shrink-0" />
      </div>

      {/* Excerpt */}
      {article.excerpt ? (
        <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">
          {article.excerpt}
        </p>
      ) : null}

      {/* Category + linked indicator */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">{categoryName}</Badge>
        {isLinked ? (
          <Badge
            variant="secondary"
            className="gap-1"
            title={`Linked to ${article.linkCount} ${
              article.linkCount === 1 ? "item" : "items"
            }`}
          >
            <LinkIcon className="size-3" />
            {article.linkCount} linked
          </Badge>
        ) : null}
      </div>

      {/* Footer: owner + reading time, pinned to the bottom for an even grid */}
      <div className="mt-auto flex items-center justify-between gap-2 pt-4">
        <div className="flex min-w-0 items-center gap-2">
          <UserAvatar
            size="sm"
            firstName={author?.firstName}
            lastName={author?.lastName}
            email={author?.email ?? ""}
            title={
              author ? `${author.firstName} ${author.lastName}` : undefined
            }
          />
          <span className="truncate text-xs text-muted-foreground">
            {author
              ? `${author.firstName} ${author.lastName}`
              : "Unknown author"}
          </span>
        </div>
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
          <ClockIcon className="size-3.5" />
          {article.readingMinutes} min read
        </span>
      </div>
    </Link>
  );
}
