"use client";

import {
  ArrowPathIcon,
  ArrowUpCircleIcon,
  ArrowDownCircleIcon,
  PencilSquareIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DetailSkeleton } from "@/components/detail-panel";
import { MarkdownView } from "@/components/markdown-view";
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
import { notifyError } from "@/lib/api/notify-error";
import { formatDate } from "@/lib/utils/format";
import { ArticleLinksPanel } from "../_components/article-links-panel";
import { ArticleStatusBadge } from "../_components/article-status-badge";

export default function ArticleDetailPage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const slug = params.slug;

  const { data: article, isLoading, isError, error, refetch } =
    useArticleBySlug(slug);
  const { data: categories } = useArticleCategories();
  const { data: users } = useUsers();
  const { data: session } = useSession();

  const publishArticle = usePublishArticle();
  const unpublishArticle = useUnpublishArticle();
  const deleteArticle = useDeleteArticle();
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
          title="Article not found"
          description="It may be a draft you can't see, it was deleted, or the API is unreachable."
          onRetry={() => refetch()}
          error={error}
        />
      </div>
    );
  }

  const category = categories?.find((item) => item.id === article.categoryId);
  const author = users?.find((item) => item.id === article.authorId);
  /**
   * Edit controls: shown to any authenticated user. The API enforces authorship —
   * only the article's author can publish/unpublish/delete (returns 403 otherwise).
   * The frontend shows the controls optimistically; the server is the authority.
   */
  const canWrite = session != null;
  const isDraft = article.status === "DRAFT";

  function handlePublish() {
    if (!article) return;
    publishArticle.mutate(article.id, {
      onSuccess: () => toast.success("Article published"),
      onError: (error) => notifyError(error, "Couldn't publish the article"),
    });
  }

  function handleUnpublish() {
    if (!article) return;
    unpublishArticle.mutate(article.id, {
      onSuccess: () => toast.success("Moved back to draft"),
      onError: (error) => notifyError(error, "Couldn't unpublish the article"),
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[
              { label: "Knowledge Base", href: "/kb" },
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
                : "Unknown author"}
            </span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">
              Updated {formatDate(article.updatedAt)}
            </span>
            {article.publishedAt && (
              <>
                <span aria-hidden>·</span>
                <span className="tabular-nums">
                  Published {formatDate(article.publishedAt)}
                </span>
              </>
            )}
          </span>
        }
        actions={
          canWrite ? (
            <>
              <Button variant="outline" size="sm" asChild>
                <Link href={`/kb/${article.slug}/edit`}>
                  <PencilSquareIcon />
                  Edit
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
                  Publish
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
                  Unpublish
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete article"
                onClick={() => setDeleteOpen(true)}
              >
                <TrashIcon />
              </Button>
            </>
          ) : undefined
        }
      />

      {article.excerpt && (
        <p className="border-l-2 pl-4 text-muted-foreground italic">
          {article.excerpt}
        </p>
      )}

      <MarkdownView content={article.content} />

      <ArticleLinksPanel articleId={article.id} canWrite={canWrite} />

      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        entityLabel="article"
        name={article.title}
        onConfirm={() => deleteArticle.mutateAsync(article.id)}
        onDeleted={() => router.push("/kb")}
      >
        Published articles are visible to the whole team until then.
      </DeleteConfirmDialog>
    </div>
  );
}
