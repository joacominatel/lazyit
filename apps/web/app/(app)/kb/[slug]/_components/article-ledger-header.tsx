"use client";

import {
  ArrowDownCircleIcon,
  ArrowPathIcon,
  ArrowUpCircleIcon,
  ClockIcon,
  EllipsisHorizontalIcon,
  PencilSquareIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import type { Article } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  usePublishArticle,
  useUnpublishArticle,
  useDeleteArticle,
} from "@/lib/api/hooks/use-article-mutations";
import { useArticleVersions } from "@/lib/api/hooks/use-article-versions";
import { notifyError } from "@/lib/api/notify-error";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { ArticleVersionHistorySheet } from "@/app/(app)/kb/_components/article-version-history-sheet";

/**
 * The slim LEDGER RECORD HEADER of the KB reading view (#1106 Phase 2). Replaces the old
 * metadata-dense PageHeader with the title H1 over ONE Commit-Mono / tabular-nums record line:
 *
 *   [PUBLISHED] · v12 · Ana Díaz · updated 3d ago
 *
 * The status is the token-driven Ledger STAMP ({@link StatusBadge}, ADR-0077 — a solid ledger tag,
 * not a generic Badge). Author keeps the #900 former-member hint. Edit / publish-unpublish and a "⋯"
 * overflow collapse to a small top-right cluster; Version History moves ENTIRELY into the "⋯" menu,
 * which opens the existing side {@link ArticleVersionHistorySheet}. Delete lives in the same menu.
 *
 * The version number is read from the append-only version log (`useArticleVersions`, newest first) —
 * shown only when available, and the eager read warms the history sheet so it opens instantly.
 */
export function ArticleLedgerHeader({
  article,
  canWrite,
  canDelete,
}: {
  article: Article;
  canWrite: boolean;
  canDelete: boolean;
}) {
  const t = useTranslations("kb");
  const { relative } = useFormatters();
  const router = useRouter();

  const publishArticle = usePublishArticle();
  const unpublishArticle = useUnpublishArticle();
  const deleteArticle = useDeleteArticle();

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Latest version number for the record line ("v12"); shown only when the log resolves. The eager
  // read shares its cache key with the history sheet, so opening "⋯ → Version history" is instant.
  const { data: versionsPage } = useArticleVersions(article.id);
  const latestVersion = versionsPage?.items[0]?.version;

  // #900: the author name is EMBEDDED on the detail read so it renders even for an OFFBOARDED
  // (soft-deleted) author; `deletedAt != null` marks a former member — we still show their real name.
  const author = article.author;
  const authorName = author
    ? `${author.firstName} ${author.lastName}`.trim()
    : null;
  const isFormerMember = author?.deletedAt != null;
  const isDraft = article.status === "DRAFT";

  function handlePublish() {
    publishArticle.mutate(article.id, {
      onSuccess: () => toast.success(t("detail.toast.published")),
      onError: (error) => notifyError(error, t("detail.toast.publishError")),
    });
  }

  function handleUnpublish() {
    unpublishArticle.mutate(article.id, {
      onSuccess: () => toast.success(t("detail.toast.movedToDraft")),
      onError: (error) => notifyError(error, t("detail.toast.unpublishError")),
    });
  }

  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <h1 className="min-w-0 text-2xl font-semibold tracking-tight text-balance">
          {article.title}
        </h1>

        <div className="flex shrink-0 items-center gap-2">
          {canWrite ? (
            <>
              <Button variant="outline" size="sm" asChild>
                <Link href={`/kb/${article.slug}/edit`}>
                  <PencilSquareIcon />
                  {t("detail.edit")}
                </Link>
              </Button>
              {isDraft ? (
                <Button
                  size="sm"
                  onClick={handlePublish}
                  disabled={publishArticle.isPending}
                >
                  {publishArticle.isPending ? (
                    <ArrowPathIcon className="animate-spin" />
                  ) : (
                    <ArrowUpCircleIcon />
                  )}
                  {t("detail.publish")}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleUnpublish}
                  disabled={unpublishArticle.isPending}
                >
                  {unpublishArticle.isPending ? (
                    <ArrowPathIcon className="animate-spin" />
                  ) : (
                    <ArrowDownCircleIcon />
                  )}
                  {t("detail.unpublish")}
                </Button>
              )}
            </>
          ) : null}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("detail.moreActions")}
              >
                <EllipsisHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => setHistoryOpen(true)}>
                <ClockIcon />
                {t("versions.viewHistory")}
              </DropdownMenuItem>
              {canDelete ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setDeleteOpen(true)}
                  >
                    <TrashIcon />
                    {t("detail.delete")}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* The Commit-Mono record line — status stamp · version · author · updated (ADR-0077). */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-muted-foreground tabular-nums">
        <StatusBadge tone={isDraft ? "warning" : "success"}>
          {isDraft ? t("status.draft") : t("status.published")}
        </StatusBadge>
        {latestVersion !== undefined ? (
          <>
            <span aria-hidden>·</span>
            <span>{t("detail.versionShort", { n: latestVersion })}</span>
          </>
        ) : null}
        <span aria-hidden>·</span>
        <span className="font-sans">{authorName ?? t("detail.unknownAuthor")}</span>
        {isFormerMember ? (
          <span className="font-sans text-muted-foreground/70 italic">
            {t("detail.formerMember")}
          </span>
        ) : null}
        <span aria-hidden>·</span>
        <span>{t("detail.updatedRelative", { rel: relative(article.updatedAt) })}</span>
      </div>

      <ArticleVersionHistorySheet
        articleId={article.id}
        canWrite={canWrite}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
      />

      {canDelete ? (
        <DeleteConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          entityKey="article"
          name={article.title}
          onConfirm={() => deleteArticle.mutateAsync(article.id)}
          onDeleted={() => router.push("/kb")}
        >
          {t("detail.deleteExtra")}
        </DeleteConfirmDialog>
      ) : null}
    </header>
  );
}
