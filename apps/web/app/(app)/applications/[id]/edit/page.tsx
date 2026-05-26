"use client";

import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useApplication } from "@/lib/api/hooks/use-applications";
import { ApplicationForm } from "../../_components/application-form";

export default function EditApplicationPage() {
  const params = useParams<{ id: string }>();
  const { data: application, isLoading, isError } = useApplication(params.id);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || !application) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
        <p className="text-sm font-medium">Application not found</p>
        <p className="text-sm text-muted-foreground">It may have been deleted.</p>
        <Button variant="outline" asChild>
          <Link href="/applications">
            <ArrowLeftIcon />
            Back to Access
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-1">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href={`/applications/${application.id}`}>
            <ArrowLeftIcon />
            {application.name}
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">
          Edit application
        </h1>
      </div>
      <ApplicationForm application={application} />
    </div>
  );
}
