"use client";

import {
  ArrowPathIcon,
  CubeIcon,
  ExclamationTriangleIcon,
  KeyIcon,
  ServerStackIcon,
} from "@heroicons/react/24/outline";
import type {
  ActivityEntityType,
  RecentActivityItem,
} from "@lazyit/shared";
import Link from "next/link";
import type { ComponentType } from "react";
import { useMemo, useState } from "react";
import { RequestIdNote } from "@/components/request-id-note";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/client";
import { useDashboardActivity } from "@/lib/api/hooks/use-dashboard";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/utils/format";

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

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold tracking-tight">
        Recent activity
      </h2>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Across the estate</CardTitle>
          <CardDescription>
            The latest changes to assets, access and stock — newest first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <ActivitySkeleton />
          ) : isError ? (
            <ActivityError error={error} onRetry={() => refetch()} />
          ) : items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No activity recorded yet. Changes to assets, access and consumables
              will show up here.
            </p>
          ) : (
            <div className="space-y-4">
              <ol>
                {items.map((item, index) => (
                  <ActivityRow
                    key={`${item.entityType}-${item.entityId}-${item.action}-${item.occurredAt}-${index}`}
                    item={item}
                    isLast={index === items.length - 1}
                    now={now}
                  />
                ))}
              </ol>
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
                  Load more
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/** Per-pillar icon + the area the entity links into. */
const ENTITY_META: Record<
  ActivityEntityType,
  { icon: ComponentType<{ className?: string }>; href: (id: string) => string }
> = {
  asset: { icon: ServerStackIcon, href: (id) => `/assets/${id}` },
  application: { icon: KeyIcon, href: (id) => `/applications/${id}` },
  consumable: { icon: CubeIcon, href: (id) => `/consumables/${id}` },
};

/** Tone classes for the leading icon chip, by pillar. Full strings so Tailwind keeps them. */
const ENTITY_TONE: Record<ActivityEntityType, string> = {
  asset: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  application: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  consumable: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
};

/** One timeline row: a pillar-tinted icon, the server `summary`, the actor, and a relative time. */
function ActivityRow({
  item,
  isLast,
  now,
}: {
  item: RecentActivityItem;
  isLast: boolean;
  now: number;
}) {
  const meta = ENTITY_META[item.entityType];
  const Icon = meta.icon;
  return (
    <li className="relative flex gap-3 pb-5 last:pb-0">
      {!isLast && (
        <span
          className="absolute top-8 left-[15px] h-[calc(100%-1.5rem)] w-px bg-border"
          aria-hidden
        />
      )}
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg ring-2 ring-background",
          ENTITY_TONE[item.entityType],
        )}
        aria-hidden
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <Link
            href={meta.href(item.entityId)}
            className="text-sm font-medium outline-none hover:underline focus-visible:underline"
          >
            {item.summary}
          </Link>
          <span
            className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground"
            title={new Date(item.occurredAt).toLocaleString()}
          >
            {formatRelativeTime(item.occurredAt, now)}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {item.actorName ? (
            <>
              <ActorAvatar name={item.actorName} seed={item.actorId} />
              <span>{item.actorName}</span>
            </>
          ) : (
            <span>System</span>
          )}
        </div>
      </div>
    </li>
  );
}

/** Solid, deterministic palette for the small actor chip (mirrors UserAvatar's color scheme). */
const ACTOR_PALETTE = [
  "bg-rose-600 text-white",
  "bg-emerald-600 text-white",
  "bg-sky-600 text-white",
  "bg-violet-600 text-white",
  "bg-amber-600 text-white",
] as const;

function actorColor(seed: string): string {
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 33 + seed.charCodeAt(i)) | 0;
  }
  return ACTOR_PALETTE[Math.abs(hash) % ACTOR_PALETTE.length];
}

function actorInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase() || "?";
}

/**
 * Tiny actor avatar for the feed. The activity row carries only a display name + id (no email), so
 * initials come from the name and the color is seeded by the actor id (stable per person), falling
 * back to the name when the id is null.
 */
function ActorAvatar({ name, seed }: { name: string; seed: string | null }) {
  return (
    <Avatar size="sm" title={name}>
      <AvatarFallback className={cn("font-medium", actorColor(seed ?? name))}>
        {actorInitials(name)}
      </AvatarFallback>
    </Avatar>
  );
}

const SKELETON_KEYS = ["a", "b", "c", "d"] as const;

/** Loading placeholder mirroring the timeline rows. */
function ActivitySkeleton() {
  return (
    <ul className="space-y-5">
      {SKELETON_KEYS.map((key) => (
        <li key={key} className="flex gap-3">
          <Skeleton className="size-8 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/4" />
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
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <div className="flex flex-col items-start gap-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <ExclamationTriangleIcon className="size-5 text-muted-foreground" />
        <span className="font-medium">Couldn&apos;t load recent activity</span>
      </div>
      <p className="text-sm text-muted-foreground">
        The API may be down or unreachable.
      </p>
      <RequestIdNote requestId={requestId} />
      <Button variant="outline" size="sm" onClick={onRetry}>
        <ArrowPathIcon />
        Retry
      </Button>
    </div>
  );
}
