"use client";

import { useSession } from "next-auth/react";
import { useParams } from "next/navigation";
import { Breadcrumb } from "@/components/breadcrumb";
import { DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState } from "@/components/resource-table";
import { LockClosedIcon } from "@heroicons/react/24/outline";
import { useArticleBySlug } from "@/lib/api/hooks/use-articles";
import { ArticleForm } from "../../_components/article-form";

export default function EditArticlePage() {
  const params = useParams<{ slug: string }>();
  const { data: article, isLoading, isError, error, refetch } =
    useArticleBySlug(params.slug);
  const { data: session } = useSession();

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl">
        <DetailSkeleton panels={1} />
      </div>
    );
  }

  if (isError || !article) {
    return (
      <div className="mx-auto max-w-4xl">
        <ErrorState
          title="Article not found"
          description="It may be a draft you can't see, it was deleted, or the API is unreachable."
          onRetry={() => refetch()}
          error={error}
        />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="mx-auto max-w-4xl">
        <EmptyState
          icon={LockClosedIcon}
          title="Not signed in"
          description="You must be signed in to edit articles."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[
              { label: "Knowledge Base", href: "/kb" },
              { label: article.title, href: `/kb/${article.slug}` },
              { label: "Edit" },
            ]}
          />
        }
        title="Edit article"
        subtitle="Changes don't alter the published/draft state — use Publish on the article for that."
      />
      <ArticleForm article={article} />
    </div>
  );
}
