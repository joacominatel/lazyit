"use client";

import { ArrowPathIcon, ClockIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { ActivityRow } from "@/components/activity-row";
import { DetailPanel } from "@/components/detail-panel";
import { ErrorState } from "@/components/resource-table";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDashboardActivity } from "@/lib/api/hooks/use-dashboard";

const PAGE_SIZE = 25;

/** Grants and revocations on this application, newest first; the parent renders this only for `logs:read`. */
export function ApplicationActivityTab({ applicationId }: { applicationId: string }) {
  const t = useTranslations("applications.detail.activity");
  const filters = useMemo(
    () => ({ entityType: "application" as const, entityId: applicationId }),
    [applicationId],
  );
  const { data, isLoading, isError, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useDashboardActivity(PAGE_SIZE, filters);
  const items = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <DetailPanel title={t("title")}>
      {isError ? (
        <ErrorState title={t("errorTitle")} onRetry={() => refetch()} error={error} />
      ) : isLoading ? (
        <div className="space-y-3" aria-hidden>
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center">
          <ClockIcon className="size-6 text-muted-foreground/60" aria-hidden />
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        </div>
      ) : (
        <div className="space-y-4">
          <ol>
            {items.map((item, index) => (
              <ActivityRow
                key={`${item.action}-${item.occurredAt}-${index}`}
                item={item}
                isLast={index === items.length - 1}
                index={index}
              />
            ))}
          </ol>
          {hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage ? <ArrowPathIcon className="animate-spin" /> : null}
              {t("loadMore")}
            </Button>
          ) : null}
        </div>
      )}
    </DetailPanel>
  );
}
