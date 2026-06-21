"use client";

import { ClockIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { ArticleVersion } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { DetailPanel } from "@/components/detail-panel";
import { MarkdownView } from "@/components/markdown-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  useArticleVersion,
  useArticleVersions,
} from "@/lib/api/hooks/use-article-versions";
import { useUsers } from "@/lib/api/hooks/use-users";
import { useFormatters } from "@/lib/hooks/use-formatters";

/**
 * "Version History" panel on the KB article detail (ADR-0042, #604). Lists all saved
 * versions of the article (newest first) with author, timestamp and version number. A
 * secondary "History" affordance opens a side sheet so the primary read view stays clean.
 *
 * Clicking a version row opens a read-only content view of that snapshot in a second sheet
 * (same pattern as viewing the current article, but with a frozen body). Draft versions are
 * visible only to the author — the API enforces the same rules as for the live article.
 *
 * Restore is intentionally out of scope: ADR-0042 requires restore to write a NEW version.
 * That is a separate action (not yet implemented). The Manual notes this.
 */
export function ArticleVersionHistoryPanel({
  articleId,
}: {
  articleId: string;
}) {
  const t = useTranslations("kb");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<
    ArticleVersion | null
  >(null);

  const { data: page, isLoading } = useArticleVersions(
    historyOpen ? articleId : undefined,
  );
  const { data: users } = useUsers();

  const versions: ArticleVersion[] = page?.items ?? [];

  return (
    <>
      {/* Version detail sheet — shown when the user clicks a version row */}
      <VersionDetailSheet
        articleId={articleId}
        version={selectedVersion}
        onClose={() => setSelectedVersion(null)}
      />

      {/* History list sheet */}
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <DetailPanel
          title={t("versions.panelTitle")}
          actions={
            <SheetTrigger asChild>
              <Button size="sm" variant="outline">
                <ClockIcon />
                {t("versions.viewHistory")}
              </Button>
            </SheetTrigger>
          }
        >
          <p className="text-sm text-muted-foreground">
            {t("versions.panelDescription")}
          </p>
        </DetailPanel>

        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{t("versions.sheetTitle")}</SheetTitle>
            <SheetDescription>{t("versions.sheetDescription")}</SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-4">
            {isLoading ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("versions.loading")}
              </p>
            ) : versions.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("versions.empty")}
              </p>
            ) : (
              <ul className="divide-y">
                {versions.map((v) => (
                  <VersionRow
                    key={v.id}
                    version={v}
                    authorName={resolveAuthor(v.editedById, users)}
                    onView={() => {
                      setSelectedVersion(v);
                    }}
                    t={t}
                  />
                ))}
              </ul>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

/** Resolve a user id to a display name from the users list. */
function resolveAuthor(
  userId: string | null,
  users:
    | { id: string; firstName: string; lastName: string }[]
    | undefined,
): string | undefined {
  if (!userId || !users) return undefined;
  const user = users.find((u) => u.id === userId);
  return user ? `${user.firstName} ${user.lastName}` : undefined;
}

/** One version row in the history list. */
function VersionRow({
  version,
  authorName,
  onView,
  t,
}: {
  version: ArticleVersion;
  authorName: string | undefined;
  onView: () => void;
  t: ReturnType<typeof useTranslations<"kb">>;
}) {
  const { date } = useFormatters();

  return (
    <li className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium tabular-nums">
            {t("versions.versionLabel", { n: version.version })}
          </span>
          <Badge variant="outline" className="text-xs">
            {version.status === "DRAFT"
              ? t("status.draft")
              : t("status.published")}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {authorName ?? t("detail.unknownAuthor")}
          <span aria-hidden> · </span>
          <span className="tabular-nums">{date(version.createdAt)}</span>
        </p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={onView}
        aria-label={t("versions.viewVersionAriaLabel", {
          n: version.version,
        })}
      >
        {t("versions.viewVersion")}
      </Button>
    </li>
  );
}

/**
 * Read-only sheet showing the full content of a single past version.
 * Fetches the version by number so we always show the canonical server snapshot.
 */
function VersionDetailSheet({
  articleId,
  version,
  onClose,
}: {
  articleId: string;
  version: ArticleVersion | null;
  onClose: () => void;
}) {
  const t = useTranslations("kb");
  const { date } = useFormatters();
  const { data: users } = useUsers();

  // Fetch from the server to ensure we render the authoritative snapshot.
  const { data: fetched, isLoading } = useArticleVersion(
    articleId,
    version?.version,
  );

  const snap = fetched ?? version;

  return (
    <Sheet open={version !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-2xl">
        <SheetHeader>
          <div className="flex items-center justify-between gap-2">
            <SheetTitle className="truncate">
              {snap
                ? t("versions.versionLabel", { n: snap.version })
                : t("versions.sheetTitle")}
            </SheetTitle>
          </div>
          {snap && (
            <SheetDescription className="flex items-center gap-1.5">
              <span>
                {resolveAuthor(snap.editedById, users) ??
                  t("detail.unknownAuthor")}
              </span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{date(snap.createdAt)}</span>
              <span aria-hidden>·</span>
              <Badge variant="outline" className="text-xs">
                {snap.status === "DRAFT"
                  ? t("status.draft")
                  : t("status.published")}
              </Badge>
            </SheetDescription>
          )}
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 pb-8">
          {isLoading && !snap ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("versions.loading")}
            </p>
          ) : snap ? (
            <div className="space-y-4">
              {snap.title && (
                <h1 className="text-xl font-semibold">{snap.title}</h1>
              )}
              {snap.excerpt && (
                <p className="text-sm text-muted-foreground italic">
                  {snap.excerpt}
                </p>
              )}
              <MarkdownView content={snap.content} />
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
