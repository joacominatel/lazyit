"use client";

import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { ActivityRow } from "@/components/activity-row";
import { RequestIdNote } from "@/components/request-id-note";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { groupByDay } from "@/lib/activity-grouping";
import { ApiError } from "@/lib/api/client";
import { useDashboardActivity } from "@/lib/api/hooks/use-dashboard";

/**
 * Recent activity — the unified, cross-pillar feed (CEO Round 2). Reads the paginated
 * `GET /dashboard/activity` (backed by the `recent_activity` DB view), which merges AssetHistory,
 * AssetAssignment, AccessGrant and ConsumableMovement into one newest-first stream. This REPLACES
 * the old AssetHistory-only slice that lived on `DashboardSummary.recentActivity`.
 *
 * The row already carries a server-built `summary` and a resolved `actorName`, so the component just
 * renders — no client-side user lookup or payload decoding (contrast the per-asset history
 * timeline). Four states: loading skeletons, an error surface (with the API request id, ADR-0031),
 * an empty state, and the timeline + "Load more".
 */
export function RecentActivityPanel() {
  const t = useTranslations("dashboard");
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useDashboardActivity();
  // Snapshot "now" once so relative times stay pure across renders (react-hooks/purity).
  const [now] = useState(() => Date.now());

  const items = useMemo(
    () => (data?.pages ?? []).flatMap((page) => page.items),
    [data],
  );

  // Group the newest-first stream into "Today" / "Yesterday" / "Earlier" buckets, computed
  // against the snapshotted `now` so the dividers stay pure across renders. The stream is
  // already newest-first, so a single pass yields the dividers in order.
  const groups = useMemo(() => groupByDay(items, now), [items, now]);

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold tracking-tight">
        {t("recentActivity.heading")}
      </h2>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("recentActivity.cardTitle")}
          </CardTitle>
          <CardDescription>
            {t("recentActivity.cardDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <ActivitySkeleton />
          ) : isError ? (
            <ActivityError error={error} onRetry={() => refetch()} />
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("recentActivity.empty")}
            </p>
          ) : (
            // Issue #195: on `lg+` cap the scrollable feed to roughly the viewport so the long
            // activity stream stops dictating an ever-growing row height — that gap under the
            // sticky Pulse rail (which pins at `lg:top-6`) closes because the feed no longer
            // towers over it. The `calc(100vh-13rem)` budget leaves room for the chrome above
            // the list (section heading + card header + page padding) plus a little breathing
            // space below, so the feed end and the rail end roughly coincide. Below `lg` the cap
            // is absent: the layout is a single column and the feed flows normally (unchanged).
            // `pr-1` keeps the inner scrollbar off the row content / focus rings; `overscroll-contain`
            // stops the inner scroll from chaining to the page once the feed bottoms out. The
            // "Load more" button rides at the end of this scroll region, so it stays reachable by
            // pointer and keyboard. No new colour or motion — Tailwind utilities only (ADR-0049).
            <div className="space-y-4 lg:max-h-[calc(100vh-13rem)] lg:overflow-y-auto lg:overscroll-contain lg:pr-1">
              {groups.map((group) => (
                <div key={group.label}>
                  <p className="mb-2 text-xs font-medium text-muted-foreground">
                    {group.label}
                  </p>
                  <ol>
                    {group.items.map(({ item, index }, rowInGroup) => (
                      <ActivityRow
                        key={`${item.entityType}-${item.entityId}-${item.action}-${item.occurredAt}-${index}`}
                        item={item}
                        isLast={rowInGroup === group.items.length - 1}
                        index={index}
                        now={now}
                      />
                    ))}
                  </ol>
                </div>
              ))}
              {hasNextPage && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                >
                  {isFetchingNextPage && (
                    <ArrowPathIcon className="animate-spin" />
                  )}
                  {t("recentActivity.loadMore")}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

const SKELETON_KEYS = ["a", "b", "c", "d"] as const;

/**
 * Loading placeholder mirroring the timeline rows. The `animate-shimmer` sweep composes over
 * each Skeleton's muted fill at the call site (the vendored primitive stays untouched);
 * reduced-motion stills the sweep globally.
 */
function ActivitySkeleton() {
  return (
    <ul className="space-y-5">
      {SKELETON_KEYS.map((key) => (
        <li key={key} className="flex gap-3">
          <Skeleton className="size-8 shrink-0 rounded-lg animate-shimmer" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/3 animate-shimmer" />
            <Skeleton className="h-3 w-1/4 animate-shimmer" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Error surface for the activity fetch, with the API request id for reporting (ADR-0031). */
function ActivityError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const t = useTranslations("dashboard");
  const tc = useTranslations("common");
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <div className="flex flex-col items-start gap-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <ExclamationTriangleIcon className="size-5 text-muted-foreground" />
        <span className="font-medium">{t("recentActivity.errorTitle")}</span>
      </div>
      <p className="text-sm text-muted-foreground">
        {t("recentActivity.errorBody")}
      </p>
      <RequestIdNote requestId={requestId} />
      <Button variant="outline" size="sm" onClick={onRetry}>
        <ArrowPathIcon />
        {tc("retry")}
      </Button>
    </div>
  );
}
