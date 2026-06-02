"use client";

import { useParams } from "next/navigation";
import { Breadcrumb } from "@/components/breadcrumb";
import { DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/resource-table";
import { useApplication } from "@/lib/api/hooks/use-applications";
import { ApplicationForm } from "../../_components/application-form";

export default function EditApplicationPage() {
  const params = useParams<{ id: string }>();
  const { data: application, isLoading, isError, error, refetch } =
    useApplication(params.id);

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
          title="Application not found"
          description="It may have been deleted, or the API is unreachable."
          onRetry={() => refetch()}
          error={error}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[
              { label: "Access", href: "/applications" },
              {
                label: application.name,
                href: `/applications/${application.id}`,
              },
              { label: "Edit" },
            ]}
          />
        }
        title="Edit application"
      />
      <ApplicationForm application={application} />
    </div>
  );
}
