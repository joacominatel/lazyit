"use client";

import {
  ArrowPathIcon,
  ArrowUpCircleIcon,
  ArrowDownCircleIcon,
  PencilSquareIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DetailSkeleton } from "@/components/detail-panel";
import { MarkdownView } from "@/components/markdown-view";
import { WikiLinkProvider } from "@/components/markdown-wiki-link-view";
import { PageHeader } from "@/components/page-header";
import { Breadcrumb } from "@/components/breadcrumb";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/resource-table";
import { useArticleCategories } from "@/lib/api/hooks/use-article-categories";
import { useArticleBySlug } from "@/lib/api/hooks/use-articles";
import {
  useDeleteArticle,
  usePublishArticle,
  useUnpublishArticle,
} from "@/lib/api/hooks/use-article-mutations";
import { useUsers } from "@/lib/api/hooks/use-users";
import { useWikiLinkResolver } from "@/lib/api/hooks/use-wiki-link-resolver";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";
import { notifyError } from "@/lib/api/notify-error";
import { ArticleAliasesPanel } from "../../_components/article-aliases-panel";
import { ArticleLinksPanel } from "../../_components/article-links-panel";
import { ArticleReferencesPanel } from "../../_components/article-references-panel";
import { ArticleStatusBadge } from "../../_components/article-status-badge";
import { ArticleVersionHistoryPanel } from "../../_components/article-version-history-panel";

export function ArticleDetailView({ slug }: { slug: string }) {
  const t = useTranslations("kb");
  const { date } = useFormatters();
  const router = useRouter();

  const { data: article, isLoading, isError, error, refetch } =
    useArticleBySlug(slug);
  const { data: categories } = useArticleCategories();
  const { data: users } = useUsers();
  // Edit / Publish / Unpublish / link are article:write; deletion is article:delete. The API
  // additionally enforces authorship (only the author may mutate), so a holder who isn't the author
  // still gets a 403 — the permission is the coarse gate, authorship the finer server-side one.
  const canWrite = useCan("article:write");
  const canDelete = useCan("article:delete");

  const publishArticle = usePublishArticle();
  const unpublishArticle = useUnpublishArticle();
  const deleteArticle = useDeleteArticle();
  // Render-time `[[slug]]` resolver (ADR-0059 §3): resolved → KB link, unresolved → tooltip.
  const resolveWikiLink = useWikiLinkResolver();
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl">
        <DetailSkeleton panels={1} />
      </div>
    );
  }

  if (isError || !article) {
    return (
      <div className="mx-auto max-w-3xl">
        <ErrorState
          title={t("detail.notFoundTitle")}
          description={t("detail.notFoundDescription")}
          onRetry={() => refetch()}
          error={error}
        />
      </div>
    );
  }

  const category = categories?.find((item) => item.id === article.categoryId);
  const author = users?.find((item) => item.id === article.authorId);
  const isDraft = article.status === "DRAFT";

  function handlePublish() {
    if (!article) return;
    publishArticle.mutate(article.id, {
      onSuccess: () => toast.success(t("detail.toast.published")),
      onError: (error) =>
        notifyError(error, t("detail.toast.publishError")),
    });
  }

  function handleUnpublish() {
    if (!article) return;
    unpublishArticle.mutate(article.id, {
      onSuccess: () => toast.success(t("detail.toast.movedToDraft")),
      onError: (error) =>
        notifyError(error, t("detail.toast.unpublishError")),
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[
              { label: t("breadcrumb"), href: "/kb" },
              { label: article.title },
            ]}
          />
        }
        title={article.title}
        badge={isDraft ? <ArticleStatusBadge status="DRAFT" /> : undefined}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {category && <Badge variant="outline">{category.name}</Badge>}
            <span>
              {author
                ? `${author.firstName} ${author.lastName}`
                : t("detail.unknownAuthor")}
            </span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">
              {t("detail.updated", { date: date(article.updatedAt) })}
            </span>
            {article.publishedAt && (
              <>
                <span aria-hidden>·</span>
                <span className="tabular-nums">
                  {t("detail.published", {
                    date: date(article.publishedAt),
                  })}
                </span>
              </>
            )}
          </span>
        }
        actions={
          canWrite || canDelete ? (
            <>
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
              {canDelete ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("detail.deleteAriaLabel")}
                  onClick={() => setDeleteOpen(true)}
                >
                  <TrashIcon />
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      />

      {article.excerpt && (
        <p className="border-l-2 border-border pl-4 text-base leading-relaxed text-pretty text-muted-foreground">
          {article.excerpt}
        </p>
      )}

      <WikiLinkProvider resolve={resolveWikiLink}>
        <MarkdownView content={article.content} />
      </WikiLinkProvider>

      {/* References (article↔article backlinks, ADR-0059 §4) — DISTINCT from the asset/application
          "Linked to" panel below (article↔asset/application, ADR-0042). */}
      <ArticleReferencesPanel articleId={article.id} />

      {/* Nav-only folder aliases (ADR-0059 §2) — where this article ALSO surfaces, beyond its home. */}
      <ArticleAliasesPanel
        articleId={article.id}
        homeFolderId={article.categoryId}
        canWrite={canWrite}
      />

      <ArticleLinksPanel articleId={article.id} canWrite={canWrite} />

      <ArticleVersionHistoryPanel articleId={article.id} />

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
    </div>
  );
}
