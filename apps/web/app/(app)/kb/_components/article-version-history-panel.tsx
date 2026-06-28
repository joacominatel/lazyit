"use client";

import { ArrowUturnLeftIcon, ClockIcon } from "@heroicons/react/24/outline";
import type { ArticleVersion } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { DetailPanel } from "@/components/detail-panel";
import { MarkdownView } from "@/components/markdown-view";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { useRestoreArticleVersion } from "@/lib/api/hooks/use-article-mutations";
import {
  useArticleVersion,
  useArticleVersions,
} from "@/lib/api/hooks/use-article-versions";
import { useUsers } from "@/lib/api/hooks/use-users";
import { notifyError } from "@/lib/api/notify-error";
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
 * Restore (#848, `canWrite` only): replays a past version's title/body/excerpt through the normal
 * edit path, which appends a NEW version — history is never rewritten (ADR-0042). It does NOT change
 * the article's published/draft status. Gated on `article:write`; the API also enforces authorship.
 */
export function ArticleVersionHistoryPanel({
  articleId,
  canWrite,
}: {
  articleId: string;
  canWrite: boolean;
}) {
  const t = useTranslations("kb");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<
    ArticleVersion | null
  >(null);
  const [restoreTarget, setRestoreTarget] = useState<ArticleVersion | null>(
    null,
  );

  const { data: page, isLoading } = useArticleVersions(
    historyOpen ? articleId : undefined,
  );
  const { data: users } = useUsers();
  const restoreVersion = useRestoreArticleVersion(articleId);

  const versions: ArticleVersion[] = page?.items ?? [];

  function handleRestore(version: ArticleVersion) {
    restoreVersion.mutate(version.version, {
      onSuccess: () => {
        toast.success(t("versions.restoreToast", { n: version.version }));
        setRestoreTarget(null);
        setHistoryOpen(false);
      },
      onError: (error) => notifyError(error, t("versions.restoreError")),
    });
  }

  return (
    <>
      {/* Version detail sheet — shown when the user clicks a version row */}
      <VersionDetailSheet
        articleId={articleId}
        version={selectedVersion}
        onClose={() => setSelectedVersion(null)}
      />

      {/* Restore confirm — replays a past version as a NEW version (never rewrites history). */}
      <AlertDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => !open && setRestoreTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("versions.restoreConfirmTitle", {
                n: restoreTarget?.version ?? 0,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("versions.restoreConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoreVersion.isPending}>
              {t("versions.restoreCancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={restoreVersion.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (restoreTarget) handleRestore(restoreTarget);
              }}
            >
              {t("versions.restore")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
                {versions.map((v, index) => (
                  <VersionRow
                    key={v.id}
                    version={v}
                    authorName={resolveAuthor(v.editedById, users)}
                    onView={() => {
                      setSelectedVersion(v);
                    }}
                    // Restore is offered for past versions only — restoring the latest (the live
                    // content) would be a no-op (the API skips an identical snapshot anyway).
                    onRestore={
                      canWrite && index > 0
                        ? () => setRestoreTarget(v)
                        : undefined
                    }
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
  onRestore,
  t,
}: {
  version: ArticleVersion;
  authorName: string | undefined;
  onView: () => void;
  /** Present only when the caller may restore this (past) version (`article:write`). */
  onRestore?: () => void;
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
      <div className="flex shrink-0 items-center gap-1">
        {onRestore ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={onRestore}
            aria-label={t("versions.restoreVersionAriaLabel", {
              n: version.version,
            })}
          >
            <ArrowUturnLeftIcon />
            {t("versions.restore")}
          </Button>
        ) : null}
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
      </div>
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
