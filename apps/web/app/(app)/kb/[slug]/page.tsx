"use client";

import {
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowUpCircleIcon,
  ArrowDownCircleIcon,
  PencilSquareIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { MarkdownView } from "@/components/markdown-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useActingUserId } from "@/lib/api/acting-user";
import { useArticleCategories } from "@/lib/api/hooks/use-article-categories";
import { useArticleBySlug } from "@/lib/api/hooks/use-articles";
import {
  useDeleteArticle,
  usePublishArticle,
  useUnpublishArticle,
} from "@/lib/api/hooks/use-article-mutations";
import { useUsers } from "@/lib/api/hooks/use-users";
import { formatDate } from "@/lib/utils/format";
import { ArticleStatusBadge } from "../_components/article-status-badge";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function ArticleDetailPage() {
  const params = useParams<{ slug: string }>();
  const router = useRouter();
  const slug = params.slug;

  const { data: article, isLoading, isError } = useArticleBySlug(slug);
  const { data: categories } = useArticleCategories();
  const { data: users } = useUsers();
  const actingUserId = useActingUserId();

  const publishArticle = usePublishArticle();
  const unpublishArticle = useUnpublishArticle();
  const deleteArticle = useDeleteArticle();
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-40" />
        <div className="space-y-2 pt-4">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      </div>
    );
  }

  if (isError || !article) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
        <p className="text-sm font-medium">Article not found</p>
        <p className="text-sm text-muted-foreground">
          It may be a draft you can&apos;t see, or it was deleted.
        </p>
        <Button variant="outline" asChild>
          <Link href="/kb">
            <ArrowLeftIcon />
            Back to Knowledge Base
          </Link>
        </Button>
      </div>
    );
  }

  const category = categories?.find((item) => item.id === article.categoryId);
  const author = users?.find((item) => item.id === article.authorId);
  const canWrite = actingUserId != null && actingUserId === article.authorId;
  const isDraft = article.status === "DRAFT";

  function handlePublish() {
    if (!article) return;
    publishArticle.mutate(article.id, {
      onSuccess: () => toast.success("Article published"),
      onError: (error) =>
        toast.error(errorMessage(error, "Couldn't publish the article")),
    });
  }

  function handleUnpublish() {
    if (!article) return;
    unpublishArticle.mutate(article.id, {
      onSuccess: () => toast.success("Moved back to draft"),
      onError: (error) =>
        toast.error(errorMessage(error, "Couldn't unpublish the article")),
    });
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/kb">
            <ArrowLeftIcon />
            Knowledge Base
          </Link>
        </Button>
        {canWrite && (
          <div className="flex items-center gap-2">
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
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">
            {article.title}
          </h1>
          {isDraft && <ArticleStatusBadge status="DRAFT" />}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          {category && <Badge variant="outline">{category.name}</Badge>}
          <span>
            {author ? `${author.firstName} ${author.lastName}` : "Unknown author"}
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
        </div>
      </div>

      {article.excerpt && (
        <p className="border-l-2 pl-4 text-muted-foreground italic">
          {article.excerpt}
        </p>
      )}

      <MarkdownView content={article.content} />

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
