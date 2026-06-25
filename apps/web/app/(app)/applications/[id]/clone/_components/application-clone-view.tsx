"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Breadcrumb } from "@/components/breadcrumb";
import { DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/resource-table";
import { useApplication } from "@/lib/api/hooks/use-applications";
import { ApplicationForm } from "../../../_components/application-form";

/**
 * Clone an Application: mirrors `/[id]/edit` but renders the create form pre-filled from the source
 * record (issue #125). It fetches the source by id and hands it to {@link ApplicationForm} as
 * `cloneSource`, so the form stays in CREATE mode (CreateApplicationSchema + create mutation) with a
 * " (copy)" name; there's no unique business field. The carried `url` is re-validated (SEC-008) and
 * the deep-copied `metadata` rides along into the create body.
 */
export function ApplicationCloneView({ id }: { id: string }) {
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
          { label: t("form.breadcrumbClone") },
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
        title={t("form.cloneTitle")}
        subtitle={t("form.cloneSubtitle")}
      />
      <ApplicationForm cloneSource={application} />
    </div>
  );
}
