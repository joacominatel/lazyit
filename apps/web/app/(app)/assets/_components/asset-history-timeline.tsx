"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type {
  AssetHistory,
  AssetHistoryEventType,
  User,
} from "@lazyit/shared";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { UserAvatar } from "@/components/user-avatar";
import { useAssetHistory } from "@/lib/api/hooks/use-asset-history";
import { useUsers } from "@/lib/api/hooks/use-users";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/utils/format";

const EVENT_LABEL: Record<AssetHistoryEventType, string> = {
  CREATED: "Created",
  STATUS_CHANGED: "Status",
  ASSIGNED: "Assigned",
  RELEASED: "Released",
  LOCATION_CHANGED: "Location",
  MODEL_CHANGED: "Model",
  SPECS_CHANGED: "Specs",
  DELETED: "Deleted",
  RESTORED: "Restored",
};

const EVENT_TONE: Record<AssetHistoryEventType, string> = {
  CREATED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  STATUS_CHANGED: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  ASSIGNED: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  RELEASED: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  LOCATION_CHANGED: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  MODEL_CHANGED: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  SPECS_CHANGED: "bg-muted text-muted-foreground",
  DELETED: "bg-destructive/10 text-destructive",
  RESTORED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The AssetHistory event log (ADR-0033) as a vertical timeline. Reads its own paginated history
 * (cursor on id) plus the users list to resolve actors and the `{userId}` payloads of
 * ASSIGNED/RELEASED. Self-contained — the detail page just drops it into a panel.
 */
export function AssetHistoryTimeline({ assetId }: { assetId: string }) {
  const {
    data,
    isLoading,
    isError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useAssetHistory(assetId);
  const { data: users } = useUsers();
  // Snapshot "now" once so relative times stay pure across renders (react-hooks/purity).
  const [now] = useState(() => Date.now());

  const userById = useMemo(
    () => new Map<string, User>((users ?? []).map((user) => [user.id, user])),
    [users],
  );
  const events = useMemo(() => (data?.pages ?? []).flat(), [data]);

  function userName(id: string | undefined): string {
    if (!id) return "someone";
    const user = userById.get(id);
    return user ? `${user.firstName} ${user.lastName}` : "a user";
  }

  /** Contextual detail for an event (the type itself is shown as a badge). */
  function detail(event: AssetHistory): string | null {
    const payload = event.payload ?? {};
    switch (event.eventType) {
      case "STATUS_CHANGED": {
        const from = asString(payload.from);
        const to = asString(payload.to);
        return from && to ? `${from} → ${to}` : null;
      }
      case "ASSIGNED":
        return `to ${userName(asString(payload.userId))}`;
      case "RELEASED":
        return `from ${userName(asString(payload.userId))}`;
      case "CREATED":
        return "Asset created";
      case "LOCATION_CHANGED":
        return "Location updated";
      case "MODEL_CHANGED":
        return "Model updated";
      case "SPECS_CHANGED":
        return "Specs updated";
      case "DELETED":
        return "Asset deleted";
      case "RESTORED":
        return "Asset restored";
      default:
        return null;
    }
  }

  if (isLoading) {
    return (
      <ul className="space-y-4">
        {["a", "b", "c"].map((key) => (
          <li key={key} className="flex gap-3">
            <Skeleton className="mt-1 size-2.5 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </li>
        ))}
      </ul>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-sm text-muted-foreground">
          Couldn&apos;t load the activity log.
        </p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <ArrowPathIcon />
          Retry
        </Button>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
    );
  }

  return (
    <div className="space-y-4">
      <ol>
        {events.map((event, index) => {
          const actor = event.performedById
            ? userById.get(event.performedById)
            : undefined;
          const text = detail(event);
          const isLast = index === events.length - 1;
          return (
            <li key={event.id} className="relative flex gap-3 pb-5 last:pb-0">
              {!isLast && (
                <span
                  className="absolute top-3 left-[5px] h-full w-px bg-border"
                  aria-hidden
                />
              )}
              <span
                className="mt-1.5 size-2.5 shrink-0 rounded-full bg-border ring-2 ring-background"
                aria-hidden
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "inline-flex rounded-md px-1.5 py-0.5 text-xs font-medium",
                      EVENT_TONE[event.eventType],
                    )}
                  >
                    {EVENT_LABEL[event.eventType]}
                  </span>
                  {text && <span className="text-sm">{text}</span>}
                  <span
                    className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground"
                    title={new Date(event.createdAt).toLocaleString()}
                  >
                    {formatRelativeTime(event.createdAt, now)}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {actor ? (
                    <>
                      <UserAvatar
                        size="sm"
                        firstName={actor.firstName}
                        lastName={actor.lastName}
                        email={actor.email}
                      />
                      <span>
                        {actor.firstName} {actor.lastName}
                      </span>
                    </>
                  ) : (
                    <span>System</span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
        >
          {isFetchingNextPage && <ArrowPathIcon className="animate-spin" />}
          Load more
        </Button>
      )}
    </div>
  );
}
