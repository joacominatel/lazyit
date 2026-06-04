"use client";

import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  Bars3BottomLeftIcon,
  CalendarDaysIcon,
  ClockIcon,
  PrinterIcon,
  TableCellsIcon,
  UserIcon,
} from "@heroicons/react/24/outline";
import type {
  ActivityEntityType,
  RecentActivityItem,
} from "@lazyit/shared";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  ActivityRow,
  ActorAvatar,
  ENTITY_META,
} from "@/components/activity-row";
import { ActiveFilters, ClearFiltersLink } from "@/components/active-filters";
import { Breadcrumb } from "@/components/breadcrumb";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import {
  ErrorState,
  LinkableRow,
  Pagination,
  ResourceCard,
  ResourceCardMeta,
  type ResourceColumn,
  ResourceTable,
} from "@/components/resource-table";
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { TableCell } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { groupByDay } from "@/lib/activity-grouping";
import { actionLabel, actionTone } from "@/lib/activity-tones";
import {
  REPORTS_ACTIVITY_PAGE_SIZE,
  useDashboardActivity,
} from "@/lib/api/hooks/use-dashboard";
import { useListParams } from "@/lib/hooks/use-list-params";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/utils/format";
import { downloadCsv } from "./informes-csv";

/**
 * The Reports/Informes screen body (rendered only once `logs:read` is confirmed — see `page.tsx`).
 *
 * It reuses the unified `GET /dashboard/activity` feed at a WIDER page size (50) and filters the
 * loaded window CLIENT-SIDE (v1 caveat): tabs scope by entity pillar, the search/action/range
 * filters narrow further, and a "Filtering the N loaded events" hint is shown whenever a client
 * filter is active so the partial-window nature is honest. Two views share the filtered rows: a
 * Timeline (the reused activity row, day-grouped, "Load more") and a Table (`ResourceTable`,
 * client-paginated). CSV + Print export exactly the visible rows.
 */

/** The view/scope tabs. The enabled three map to an entity pillar; the two debt tabs are disabled. */
const TABS = [
  { value: "all", label: "All", entityType: null },
  { value: "assets", label: "Assets", entityType: "asset" },
  { value: "access", label: "Access", entityType: "application" },
  { value: "stock", label: "Stock", entityType: "consumable" },
] as const;

type TabValue = (typeof TABS)[number]["value"];

/** Active-tab underline tint per tab (token-backed pillar hue; brand indigo for "All"). */
const TAB_INDICATOR: Record<TabValue, string> = {
  all: "data-[state=active]:border-primary",
  assets: "data-[state=active]:border-pillar-inventory",
  access: "data-[state=active]:border-pillar-access",
  stock: "data-[state=active]:border-pillar-inventory",
};

/** Relative-range options, applied client-side over `occurredAt`. */
const RANGE_OPTIONS = [
  { value: "all", label: "All time" },
  { value: "today", label: "Today" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
] as const;

type RangeValue = (typeof RANGE_OPTIONS)[number]["value"];

const DAY_MS = 24 * 60 * 60 * 1000;

const FILTER_DEFAULTS = {
  tab: "all",
  action: "ALL",
  range: "all",
  view: "timeline",
} as const;

/** Window start (epoch ms) for a relative range, or null for "all time". */
function rangeStart(range: RangeValue, now: number): number | null {
  switch (range) {
    case "today": {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }
    case "7d":
      return now - 7 * DAY_MS;
    case "30d":
      return now - 30 * DAY_MS;
    default:
      return null;
  }
}

export function InformesScreen() {
  // Snapshot "now" once so relative times + the range filter stay pure across renders.
  const [now] = useState(() => Date.now());
  const {
    q,
    offset,
    limit,
    filters,
    setQ,
    setFilter,
    setOffset,
    clearFilters,
    filtersActive,
  } = useListParams({
    filters: FILTER_DEFAULTS,
    // The table view is client-paginated over the filtered rows; a roomy page keeps it scannable.
    defaultLimit: 25,
  });

  const tab = (filters.tab as TabValue) ?? "all";
  const actionFilter = filters.action;
  const range = (filters.range as RangeValue) ?? "all";
  const view = filters.view === "table" ? "table" : "timeline";

  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useDashboardActivity(REPORTS_ACTIVITY_PAGE_SIZE);

  // The full loaded window (every page fetched so far), newest-first.
  const loaded = useMemo(
    () => (data?.pages ?? []).flatMap((page) => page.items),
    [data],
  );
  const total = data?.pages[0]?.total ?? 0;

  // Distinct action verbs present in the loaded window → the action filter's options (so we never
  // offer a verb that isn't here). Sorted by their human label for a stable, readable menu.
  const actionOptions = useMemo(() => {
    const seen = new Set(loaded.map((item) => item.action));
    return [...seen].sort((a, b) => actionLabel(a).localeCompare(actionLabel(b)));
  }, [loaded]);

  const tabEntityType = useMemo<ActivityEntityType | null>(
    () => TABS.find((t) => t.value === tab)?.entityType ?? null,
    [tab],
  );

  // Client-side filtering over the loaded window (v1): tab → entity pillar, search → summary+actor,
  // action → verb, range → occurredAt window.
  const filtered = useMemo(() => {
    const windowStart = rangeStart(range, now);
    const needle = q.trim().toLowerCase();
    return loaded.filter((item) => {
      if (tabEntityType && item.entityType !== tabEntityType) return false;
      if (actionFilter !== "ALL" && item.action !== actionFilter) return false;
      if (windowStart != null && new Date(item.occurredAt).getTime() < windowStart) {
        return false;
      }
      if (needle) {
        const haystack = `${item.summary} ${item.actorName ?? ""}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [loaded, tabEntityType, actionFilter, range, now, q]);

  // A client filter is "narrowing" when it actually drops rows from the loaded window — that's when
  // the partial-window caveat matters, so the hint is shown then.
  const clientFilterActive =
    tab !== "all" || actionFilter !== "ALL" || range !== "all" || q.trim() !== "";

  const chips = [
    ...(q
      ? [{ key: "q", label: `Search: “${q}”`, onClear: () => setQ("") }]
      : []),
    ...(tab !== "all"
      ? [
          {
            key: "tab",
            label: `Scope: ${TABS.find((t) => t.value === tab)?.label ?? tab}`,
            onClear: () => setFilter("tab", FILTER_DEFAULTS.tab),
          },
        ]
      : []),
    ...(actionFilter !== "ALL"
      ? [
          {
            key: "action",
            label: `Action: ${actionLabel(actionFilter)}`,
            onClear: () => setFilter("action", FILTER_DEFAULTS.action),
          },
        ]
      : []),
    ...(range !== "all"
      ? [
          {
            key: "range",
            label: `Range: ${RANGE_OPTIONS.find((r) => r.value === range)?.label ?? range}`,
            onClear: () => setFilter("range", FILTER_DEFAULTS.range),
          },
        ]
      : []),
  ];

  const header = (
    <PageHeader
      title="Informes"
      breadcrumb={<Breadcrumb />}
      subtitle="Every change across your estate — newest first."
      actions={
        <div className="flex items-center gap-2" data-print-hide>
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadCsv(filtered)}
            disabled={filtered.length === 0}
            title="Export the events currently visible (the filtered window)"
          >
            <ArrowDownTrayIcon />
            Export visible events
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.print()}
            title="Print the report"
          >
            <PrinterIcon />
            Print
          </Button>
        </div>
      }
    />
  );

  if (isError) {
    return (
      <div className="space-y-6">
        {header}
        <ErrorState
          title="Couldn't load the activity history"
          onRetry={() => refetch()}
          error={error}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-print-document>
      {header}

      {/* Scope tabs. The three enabled tabs filter client-side by entity pillar; Users and My history
          are disabled with a native-title tooltip until history coverage lands. */}
      <div data-print-hide>
        <Tabs value={tab} onValueChange={(value) => setFilter("tab", value)}>
          <TabsList>
            {TABS.map((t) => (
              <TabsTrigger
                key={t.value}
                value={t.value}
                indicatorClassName={TAB_INDICATOR[t.value]}
              >
                {t.label}
              </TabsTrigger>
            ))}
            {/* DEBT-1: needs per-actor / self history coverage. Disabled, not hidden, so the roadmap
                is visible; the native title carries the "why". These are inert (no `value` route). */}
            <span
              className="-mb-px inline-flex h-9 shrink-0 cursor-not-allowed items-center gap-1.5 border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground/50"
              title="Available once history coverage lands"
              aria-disabled="true"
            >
              <UserIcon className="size-4" aria-hidden />
              Users
            </span>
            <span
              className="-mb-px inline-flex h-9 shrink-0 cursor-not-allowed items-center gap-1.5 border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground/50"
              title="Available once history coverage lands"
              aria-disabled="true"
            >
              My history
            </span>
          </TabsList>
        </Tabs>
      </div>

      {/* Filter bar. Search / Action / Range are live (client-side); Actor and an exact date range are
          DEBT-1, rendered disabled-with-tooltip so the surface is honest about what's coming. */}
      <div
        className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center"
        data-print-hide
      >
        <SearchInput
          value={q}
          onChange={setQ}
          debounceMs={250}
          onDebouncedChange={setQ}
          label="Search activity"
          placeholder="Search summaries and people…"
          className="lg:max-w-xs lg:flex-1"
        />
        <Select
          value={actionFilter}
          onValueChange={(value) => setFilter("action", value)}
        >
          <SelectTrigger className="lg:w-48">
            <SelectValue placeholder="All actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">All actions</SelectItem>
            {actionOptions.map((action) => (
              <SelectItem key={action} value={action}>
                {actionLabel(action)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={range}
          onValueChange={(value) => setFilter("range", value)}
        >
          <SelectTrigger className="lg:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* DEBT-1: actor filter + exact date range. Disabled-with-tooltip until the feed carries the
            data to drive them server-side. */}
        <span title="Coming soon — filter by who made the change">
          <Button variant="outline" size="sm" disabled className="gap-1.5">
            <UserIcon />
            Actor
          </Button>
        </span>
        <span title="Coming soon — pick an exact date range">
          <Button variant="outline" size="sm" disabled className="gap-1.5">
            <CalendarDaysIcon />
            Exact range
          </Button>
        </span>

        {/* View toggle: Timeline (comfortable) ↔ Table (dense). */}
        <div className="ml-auto inline-flex items-center gap-1 rounded-lg border p-0.5">
          <ViewToggleButton
            active={view === "timeline"}
            onClick={() => setFilter("view", "timeline")}
            icon={Bars3BottomLeftIcon}
            label="Timeline"
          />
          <ViewToggleButton
            active={view === "table"}
            onClick={() => setFilter("view", "table")}
            icon={TableCellsIcon}
            label="Table"
          />
        </div>
      </div>

      <div data-print-hide>
        <ActiveFilters chips={chips} onClearAll={clearFilters} />
      </div>

      {/* Honest v1 caveat: the filters run over the loaded window, not the whole history. */}
      {clientFilterActive && !isLoading ? (
        <p
          className="text-xs text-muted-foreground tabular-nums"
          aria-live="polite"
          data-print-hide
        >
          Filtering the {loaded.length} loaded event
          {loaded.length === 1 ? "" : "s"}
          {hasNextPage ? " — load more to widen the search" : ""}.
        </p>
      ) : null}

      {isLoading ? (
        <TimelineSkeleton />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={ClockIcon}
          pillar="access"
          title="No events match these filters"
          description={
            filtersActive
              ? "Nothing in the loaded window matches. Clear a filter, or load more events to widen the search."
              : "Changes to assets, access and stock will show up here as your team works."
          }
        >
          {filtersActive ? (
            <ClearFiltersLink onClick={clearFilters} />
          ) : null}
        </EmptyState>
      ) : view === "timeline" ? (
        <TimelineView
          items={filtered}
          now={now}
          hasNextPage={!!hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={() => fetchNextPage()}
        />
      ) : (
        <TableView
          items={filtered}
          now={now}
          offset={offset}
          limit={limit}
          onOffsetChange={setOffset}
          onClearFilters={clearFilters}
          hasNextPage={!!hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={() => fetchNextPage()}
        />
      )}

      {/* Honest total context for the loaded window (also useful on the printed sheet). */}
      <p className="text-xs text-muted-foreground tabular-nums">
        Showing {filtered.length} of {loaded.length} loaded event
        {loaded.length === 1 ? "" : "s"}
        {total > loaded.length ? ` (${total} total in history)` : ""}.
      </p>
    </div>
  );
}

/** A single segmented view-toggle button (Timeline / Table). */
function ViewToggleButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof ClockIcon;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={`${label} view`}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-4" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

/** The day-grouped timeline, reusing the shared {@link ActivityRow}, with an action badge per row. */
function TimelineView({
  items,
  now,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  items: RecentActivityItem[];
  now: number;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
  const groups = useMemo(() => groupByDay(items, now), [items, now]);
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <div key={group.label}>
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            {group.label}
          </p>
          <ol>
            {group.items.map(({ item, index }, rowInGroup) => (
              <ActivityRowWithBadge
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
      {hasNextPage ? (
        <Button
          variant="outline"
          size="sm"
          onClick={onLoadMore}
          disabled={isFetchingNextPage}
          data-print-hide
        >
          {isFetchingNextPage ? <ArrowPathIcon className="animate-spin" /> : null}
          Load more
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The shared {@link ActivityRow} with a trailing action StatusBadge. The badge sits in a flex row so
 * the row keeps its single-line summary while the action verb gets a solid, AA-safe tone chip
 * (`actionTone`). The base row is unchanged on the dashboard (where no badge is rendered).
 */
function ActivityRowWithBadge({
  item,
  isLast,
  index,
  now,
}: {
  item: RecentActivityItem;
  isLast: boolean;
  index: number;
  now: number;
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <ActivityRow item={item} isLast={isLast} index={index} now={now} />
      </div>
      <StatusBadge tone={actionTone(item.action)} className="mt-0.5 shrink-0">
        {actionLabel(item.action)}
      </StatusBadge>
    </div>
  );
}

/** The dense table view, client-paginated over the filtered rows (filtering is client-side in v1). */
function TableView({
  items,
  now,
  offset,
  limit,
  onOffsetChange,
  onClearFilters,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  items: RecentActivityItem[];
  now: number;
  offset: number;
  limit: number;
  onOffsetChange: (offset: number) => void;
  onClearFilters: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
  // Client-page the filtered rows. Clamp the offset so a filter that shrinks the set never strands
  // the view past the end.
  const safeOffset = offset < items.length ? offset : 0;
  const pageRows = items.slice(safeOffset, safeOffset + limit);

  const columns: ResourceColumn[] = [
    { key: "when", header: "When", skeleton: <Skeleton className="h-4 w-20" /> },
    {
      key: "action",
      header: "Action",
      skeleton: <Skeleton className="h-5 w-20 rounded-full" />,
    },
    {
      key: "entity",
      header: "Entity",
      skeleton: <Skeleton className="h-4 w-16" />,
    },
    {
      key: "actor",
      header: "Actor",
      skeleton: <Skeleton className="h-4 w-24" />,
    },
    {
      key: "summary",
      header: "Summary",
      skeleton: <Skeleton className="h-4 w-48" />,
    },
  ];

  return (
    <>
      <ResourceTable
        columns={columns}
        isFilteredEmpty={pageRows.length === 0}
        filteredEmptyMessage="No events match these filters."
        filteredEmptyAction={<ClearFiltersLink onClick={onClearFilters} />}
        mobileChildren={pageRows.map((item) => {
          const meta = ENTITY_META[item.entityType];
          return (
            <ResourceCard
              key={`${item.entityType}-${item.entityId}-${item.action}-${item.occurredAt}`}
              href={meta.href(item.entityId)}
              title={item.summary}
              badge={
                <StatusBadge tone={actionTone(item.action)}>
                  {actionLabel(item.action)}
                </StatusBadge>
              }
              meta={
                <>
                  <ResourceCardMeta label="When">
                    <span
                      className="tabular-nums"
                      title={new Date(item.occurredAt).toLocaleString()}
                    >
                      {formatRelativeTime(item.occurredAt, now)}
                    </span>
                  </ResourceCardMeta>
                  <ResourceCardMeta label="Entity">
                    <span className="capitalize">{item.entityType}</span>
                  </ResourceCardMeta>
                  <ResourceCardMeta label="Actor">
                    {item.actorName ?? "System"}
                  </ResourceCardMeta>
                </>
              }
            />
          );
        })}
      >
        {pageRows.map((item) => {
          const meta = ENTITY_META[item.entityType];
          const EntityIcon = meta.icon;
          return (
            <LinkableRow
              key={`${item.entityType}-${item.entityId}-${item.action}-${item.occurredAt}`}
              href={meta.href(item.entityId)}
            >
              <TableCell
                className="text-muted-foreground tabular-nums whitespace-nowrap"
                title={new Date(item.occurredAt).toLocaleString()}
              >
                {formatRelativeTime(item.occurredAt, now)}
              </TableCell>
              <TableCell>
                <StatusBadge tone={actionTone(item.action)}>
                  {actionLabel(item.action)}
                </StatusBadge>
              </TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-1.5">
                  <EntityIcon
                    className="size-4 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="capitalize">{item.entityType}</span>
                </span>
              </TableCell>
              <TableCell>
                {item.actorName ? (
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <ActorAvatar name={item.actorName} seed={item.actorId} />
                    <span className="min-w-0 truncate">{item.actorName}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">System</span>
                )}
              </TableCell>
              <TableCell className="max-w-md">
                <Link
                  href={meta.href(item.entityId)}
                  className="block truncate font-medium hover:underline"
                  title={item.summary}
                >
                  {item.summary}
                </Link>
              </TableCell>
            </LinkableRow>
          );
        })}
      </ResourceTable>

      <Pagination
        total={items.length}
        limit={limit}
        offset={safeOffset}
        itemCount={pageRows.length}
        onOffsetChange={onOffsetChange}
      />

      {hasNextPage ? (
        <div data-print-hide>
          <Button
            variant="outline"
            size="sm"
            onClick={onLoadMore}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? (
              <ArrowPathIcon className="animate-spin" />
            ) : null}
            Load more events
          </Button>
        </div>
      ) : null}
    </>
  );
}

const SKELETON_KEYS = ["a", "b", "c", "d", "e"] as const;

/** Loading placeholder mirroring the timeline rows. */
function TimelineSkeleton() {
  return (
    <ul className="space-y-5">
      {SKELETON_KEYS.map((key) => (
        <li key={key} className="flex gap-3">
          <Skeleton className="size-7 shrink-0 rounded-lg animate-shimmer" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/3 animate-shimmer" />
            <Skeleton className="h-3 w-1/4 animate-shimmer" />
          </div>
          <Skeleton className="h-5 w-16 rounded-full animate-shimmer" />
        </li>
      ))}
    </ul>
  );
}
