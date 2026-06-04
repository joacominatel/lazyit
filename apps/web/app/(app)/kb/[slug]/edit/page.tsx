"use client";

import { useTranslations } from "next-intl";
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
  const t = useTranslations("kb");
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
          title={t("detail.notFoundTitle")}
          description={t("detail.notFoundDescription")}
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
          title={t("form.notSignedInTitle")}
          description={t("form.notSignedInDescription")}
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
              { label: t("breadcrumb"), href: "/kb" },
              { label: article.title, href: `/kb/${article.slug}` },
              { label: t("form.editCrumb") },
            ]}
          />
        }
        title={t("form.editTitle")}
        subtitle={t("form.editSubtitle")}
      />
      <ArticleForm article={article} />
    </div>
  );
}
