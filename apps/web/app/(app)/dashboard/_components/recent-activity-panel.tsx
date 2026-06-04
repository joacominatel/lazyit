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
import type { ComponentType, CSSProperties } from "react";
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
import { avatarColorFor } from "@/lib/avatar-color";
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

  // Group the newest-first stream into "Today" / "Yesterday" / "Earlier" buckets, computed
  // against the snapshotted `now` so the dividers stay pure across renders. The stream is
  // already newest-first, so a single pass yields the dividers in order.
  const groups = useMemo(() => groupByDay(items, now), [items, now]);

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
              {groups.map((group) => (
                <div key={group.label}>
                  <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground/70 uppercase">
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

/**
 * Cap the staggered settle to the first page's worth of rows: beyond this, the rise-in delay
 * is clamped so a long feed (or "Load more"-appended pages) never grows a sluggish cascade —
 * the stagger is a first-mount reveal, not a per-row reflex. ~8 keeps the total under ~190ms.
 */
const STAGGER_CAP = 8;

/** A day bucket of activity rows, carrying each row's GLOBAL index for the capped stagger. */
interface ActivityGroup {
  label: string;
  items: { item: RecentActivityItem; index: number }[];
}

/** Local Y-M-D key for a timestamp, so "same day" is judged in the viewer's local zone. */
function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Bucket a newest-first activity stream into Today / Yesterday / Earlier, comparing each
 * row's local calendar day against the snapshotted `now`. Single pass (the stream is already
 * ordered), so the returned groups stay newest-first and carry each row's global index.
 */
function groupByDay(items: RecentActivityItem[], now: number): ActivityGroup[] {
  const today = dayKey(new Date(now));
  const yesterday = dayKey(new Date(now - 24 * 60 * 60 * 1000));
  const order = ["Today", "Yesterday", "Earlier"] as const;
  const buckets = new Map<string, { item: RecentActivityItem; index: number }[]>();
  items.forEach((item, index) => {
    const key = dayKey(new Date(item.occurredAt));
    const label =
      key === today ? "Today" : key === yesterday ? "Yesterday" : "Earlier";
    const bucket = buckets.get(label);
    if (bucket) bucket.push({ item, index });
    else buckets.set(label, [{ item, index }]);
  });
  return order
    .filter((label) => buckets.has(label))
    .map((label) => ({ label, items: buckets.get(label) ?? [] }));
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

/**
 * Tone classes for the leading icon chip, by pillar (ADR-0049). These chips hold a
 * DECORATIVE glyph (aria-hidden) — a ≥24px mark is exempt from text-AA — so the pillar hue
 * can sit as both tint (`/10` background) and glyph color. Asset + consumable are Inventory
 * (teal); application is Access (indigo). The pillar tokens carry dark parity, so the
 * hand-written `dark:` variants are gone. Full strings so the Tailwind scanner keeps them.
 */
const ENTITY_TONE: Record<ActivityEntityType, string> = {
  asset: "bg-pillar-inventory/10 text-pillar-inventory",
  application: "bg-pillar-access/10 text-pillar-access",
  consumable: "bg-pillar-inventory/10 text-pillar-inventory",
};

/** One timeline row: a pillar-tinted icon, the server `summary`, the actor, and a relative time. */
function ActivityRow({
  item,
  isLast,
  index,
  now,
}: {
  item: RecentActivityItem;
  isLast: boolean;
  /** Global 0-based position in the flattened stream, for the capped staggered settle. */
  index: number;
  now: number;
}) {
  const meta = ENTITY_META[item.entityType];
  const Icon = meta.icon;
  return (
    <li
      className="relative flex animate-rise-in gap-3 pb-5 [animation-delay:calc(var(--i)*24ms)] last:pb-0"
      style={{ "--i": Math.min(index, STAGGER_CAP) } as CSSProperties}
    >
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

function actorInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase() || "?";
}

/**
 * Tiny actor avatar for the feed. The activity row carries only a display name + id (no email), so
 * initials come from the name and the color is seeded by the actor id (stable per person), falling
 * back to the name when the id is null. Uses the canonical {@link avatarColorFor} palette so the
 * same identity gets the same color here as on Users, asset owners and access grantees.
 */
function ActorAvatar({ name, seed }: { name: string; seed: string | null }) {
  return (
    <Avatar size="sm" title={name}>
      <AvatarFallback className={cn("font-medium", avatarColorFor(seed ?? name))}>
        {actorInitials(name)}
      </AvatarFallback>
    </Avatar>
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
