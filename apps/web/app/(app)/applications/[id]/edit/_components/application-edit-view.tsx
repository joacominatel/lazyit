"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Breadcrumb } from "@/components/breadcrumb";
import { DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/resource-table";
import { useApplication } from "@/lib/api/hooks/use-applications";
import { ApplicationForm } from "../../../_components/application-form";

export function ApplicationEditView({ id }: { id: string }) {
  const t = useTranslations("applications");
  const { data: application, isLoading, isError, error, refetch } =
    useApplication(id);

  const breadcrumb = useMemo(
    () => (
      <Breadcrumb
        items={[
          { label: t("list.title"), href: "/applications" },
          {
            label: application?.name ?? "",
            href: `/applications/${application?.id ?? ""}`,
          },
          { label: t("form.breadcrumbEdit") },
        ]}
      />
    ),
    [t, application?.name, application?.id],
  );

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl">
        <DetailSkeleton panels={1} />
      </div>
    );
  }

  if (isError || !application) {
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

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        breadcrumb={breadcrumb}
        title={t("form.editTitle")}
      />
      <ApplicationForm application={application} />
    </div>
  );
}
