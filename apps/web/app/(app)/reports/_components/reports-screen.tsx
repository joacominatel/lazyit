"use client";

import {
  ArrowDownTrayIcon,
  ClockIcon,
  PrinterIcon,
  UserIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import {
  ACTIVITY_ACTOR_ME,
  type ActivityEntityType,
  RECENT_ACTIVITY_ACTIONS,
  type RecentActivityItem,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ActorAvatar, ENTITY_META } from "@/components/activity-row";
import { ActiveFilters, ClearFiltersLink } from "@/components/active-filters";
import { Breadcrumb } from "@/components/breadcrumb";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { RowsPerPageSelect } from "@/components/rows-per-page-select";
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
import { actionLabel, actionTone } from "@/lib/activity-tones";
import type { DashboardActivityFilters } from "@/lib/api/endpoints/dashboard";
import { useReportsActivityPage } from "@/lib/api/hooks/use-dashboard";
import { useUsers } from "@/lib/api/hooks/use-users";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useListParams } from "@/lib/hooks/use-list-params";
import { downloadCsv } from "./reports-csv";

/**
 * The Reports screen body (rendered only once `logs:read` is confirmed — see `page.tsx`).
 *
 * Since issue #183 (DEBT-1 frontend) every filter is **server-side**: the unified `GET
 * /dashboard/activity` feed now narrows by `entityType` (scope tabs), `actorId` (an Actor select, or
 * `"me"` for the My-history tab), `action`, `from`/`to` (a relative OR an exact date range) and free
 * text `q`. `useListParams` keeps the whole filter set in the URL (shareable / Back-navigable), and
 * the returned values map straight onto the request — there is no more client-side `.filter()` over a
 * partial window, so the `total` and the table pagination are the server's real filtered figures.
 *
 * The feed is rendered as a dense Table (`ResourceTable` with true server-side prev/next paging);
 * the earlier Timeline view was dropped (#696). CSV + Print export exactly the rows currently visible.
 */

/**
 * The view/scope tabs. The entity tabs map to a pillar (or none for "All") → the `entityType`
 * filter. `me` is the self-history view → `actorId="me"` (no entity scope). The `users` tab scopes
 * to `entityType="user"` — the User lifecycle feed now that UserHistory backs it (DEBT-2, issue #185).
 */
const TABS = [
  { value: "all", entityType: null },
  { value: "assets", entityType: "asset" },
  { value: "access", entityType: "application" },
  { value: "stock", entityType: "consumable" },
  { value: "users", entityType: "user" },
  { value: "me", entityType: null },
] as const satisfies readonly {
  value: string;
  entityType: ActivityEntityType | null;
}[];

type TabValue = (typeof TABS)[number]["value"];

/** Active-tab underline tint per tab (token-backed pillar hue; brand indigo for "All" / "My history"). */
const TAB_INDICATOR: Record<TabValue, string> = {
  all: "data-[state=active]:border-primary",
  assets: "data-[state=active]:border-pillar-inventory",
  access: "data-[state=active]:border-pillar-access",
  stock: "data-[state=active]:border-pillar-inventory",
  users: "data-[state=active]:border-pillar-manage",
  me: "data-[state=active]:border-primary",
};

/**
 * Relative-range presets. Each resolves to a concrete `[from, to]` **date pair** (`YYYY-MM-DD`) so it
 * shares the single source of truth with the exact-range inputs — there is no separate "range mode".
 * `null` means that bound is open. `to` is the LAST included day; the request converts it to the
 * closed-open upper bound (start of the following day).
 */
const RANGE_OPTIONS = [
  { value: "all" },
  { value: "today" },
  { value: "7d" },
  { value: "30d" },
] as const;

type RangeValue = (typeof RANGE_OPTIONS)[number]["value"];

const FILTER_DEFAULTS = {
  tab: "all",
  action: "ALL",
  actor: "ALL",
  // `from` / `to` are date-only (`YYYY-MM-DD`) URL filters; empty means that bound is open.
  from: "",
  to: "",
} as const;

/** Local `YYYY-MM-DD` for an epoch ms (the value an `<input type="date">` round-trips). */
function toDateInput(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The `[from, to]` date-input pair (last-included `to`) for a relative preset, against `now`. */
function presetRange(range: RangeValue, now: number): { from: string; to: string } {
  if (range === "all") return { from: "", to: "" };
  const today = toDateInput(now);
  if (range === "today") return { from: today, to: today };
  const days = range === "7d" ? 7 : 30;
  // Inclusive window: the last `days` days ending today → from = today - (days - 1).
  const from = toDateInput(now - (days - 1) * 24 * 60 * 60 * 1000);
  return { from, to: today };
}

/** Which relative preset (if any) the current `from`/`to` pair matches — else "custom". */
function matchPreset(from: string, to: string, now: number): RangeValue | "custom" {
  for (const opt of RANGE_OPTIONS) {
    const r = presetRange(opt.value, now);
    if (r.from === from && r.to === to) return opt.value;
  }
  return "custom";
}

/** Start-of-day local ISO for a `YYYY-MM-DD` (the `from` lower bound), or undefined when empty. */
function fromDateToIso(date: string): string | undefined {
  if (!date) return undefined;
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Exclusive upper-bound ISO for a `YYYY-MM-DD`: start of the FOLLOWING day, so a `to` of "Jun 4"
 * includes everything that happened on Jun 4 (the API window is closed-open `[from, to)`).
 */
function toDateToIso(date: string): string | undefined {
  if (!date) return undefined;
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

export function ReportsScreen() {
  const t = useTranslations("reports");
  const tAction = useTranslations("shared.activity.action");
  // Snapshot "now" once so the relative-range presets stay pure across renders.
  const [now] = useState(() => Date.now());
  const {
    q,
    offset,
    limit,
    filters,
    setQ,
    setFilter,
    setFilters,
    setLimit,
    setOffset,
    clearFilters,
    filtersActive,
  } = useListParams({
    filters: FILTER_DEFAULTS,
    // Server-paginated table window; a roomy page keeps it scannable.
    defaultLimit: 25,
  });

  const tab = (filters.tab as TabValue) ?? "all";
  const actionFilter = filters.action;
  const actorFilter = filters.actor;
  const fromDate = filters.from;
  const toDate = filters.to;

  const tabMeta = useMemo(() => TABS.find((t) => t.value === tab) ?? TABS[0], [tab]);
  const isMyHistory = tab === "me";
  const rangePreset = matchPreset(fromDate, toDate, now);

  // The user directory for the Actor select (small org; whole directory is one page).
  const { data: users } = useUsers();

  // Map the URL filter state → the server-side request filters (issue #183). The My-history tab
  // forces `actorId="me"` and ignores the Actor select; otherwise a concrete actor uuid is sent.
  const serverFilters = useMemo<DashboardActivityFilters>(() => {
    const out: DashboardActivityFilters = {};
    if (tabMeta.entityType) out.entityType = tabMeta.entityType;
    if (isMyHistory) {
      out.actorId = ACTIVITY_ACTOR_ME;
    } else if (actorFilter !== "ALL") {
      out.actorId = actorFilter;
    }
    if (
      actionFilter !== "ALL" &&
      (RECENT_ACTIVITY_ACTIONS as readonly string[]).includes(actionFilter)
    ) {
      out.action = actionFilter as (typeof RECENT_ACTIVITY_ACTIONS)[number];
    }
    const fromIso = fromDateToIso(fromDate);
    const toIso = toDateToIso(toDate);
    if (fromIso) out.from = fromIso;
    if (toIso) out.to = toIso;
    const needle = q.trim();
    if (needle) out.q = needle;
    return out;
  }, [tabMeta.entityType, isMyHistory, actorFilter, actionFilter, fromDate, toDate, q]);

  // A single server-side page (true prev/next) over the filtered feed.
  const {
    data: pageData,
    isLoading,
    isError,
    error,
    refetch,
  } = useReportsActivityPage(limit, offset, serverFilters);

  const items = pageData?.items ?? [];
  const total = pageData?.total ?? 0;

  const chips = [
    ...(q
      ? [
          {
            key: "q",
            label: t("filters.chips.search", { query: q }),
            onClear: () => setQ(""),
          },
        ]
      : []),
    ...(tab !== "all"
      ? [
          {
            key: "tab",
            label: t("filters.chips.scope", { value: t(`tabs.${tabMeta.value}`) }),
            onClear: () => setFilter("tab", FILTER_DEFAULTS.tab),
          },
        ]
      : []),
    ...(!isMyHistory && actorFilter !== "ALL"
      ? [
          {
            key: "actor",
            label: t("filters.chips.actor", {
              value: users?.find((u) => u.id === actorFilter)
                ? `${users.find((u) => u.id === actorFilter)?.firstName} ${users.find((u) => u.id === actorFilter)?.lastName}`
                : t("filters.selectedUser"),
            }),
            onClear: () => setFilter("actor", FILTER_DEFAULTS.actor),
          },
        ]
      : []),
    ...(actionFilter !== "ALL"
      ? [
          {
            key: "action",
            label: t("filters.chips.action", {
              value: actionLabel(actionFilter, tAction),
            }),
            onClear: () => setFilter("action", FILTER_DEFAULTS.action),
          },
        ]
      : []),
    ...(fromDate || toDate
      ? [
          {
            key: "range",
            label:
              rangePreset !== "custom" && rangePreset !== "all"
                ? t("filters.chips.rangePreset", {
                    value: t(`filters.range.${rangePreset}`),
                  })
                : t("filters.chips.rangeCustom", {
                    from: fromDate || "…",
                    to: toDate || "…",
                  }),
            // Clear both bounds in one navigation (#217) — two setFilter calls would clobber,
            // dropping one bound.
            onClear: () =>
              setFilters({
                from: FILTER_DEFAULTS.from,
                to: FILTER_DEFAULTS.to,
              }),
          },
        ]
      : []),
  ];

  const header = (
    <PageHeader
      title={t("page.title")}
      breadcrumb={<Breadcrumb />}
      subtitle={t("page.subtitle")}
      actions={
        <div className="flex items-center gap-2" data-print-hide>
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadCsv(items)}
            disabled={items.length === 0}
            title={t("export.exportTitle")}
          >
            <ArrowDownTrayIcon />
            {t("export.exportVisible")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => window.print()}
            title={t("export.printTitle")}
          >
            <PrinterIcon />
            {t("export.print")}
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
          title={t("empty.errorTitle")}
          onRetry={() => refetch()}
          error={error}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-print-document>
      {header}

      {/* Scope tabs. The entity tabs scope by pillar (server-side); "Users" scopes the User lifecycle
          feed (entityType="user", DEBT-2); "My history" filters to the caller (actorId="me"). */}
      <div data-print-hide>
        <Tabs value={tab} onValueChange={(value) => setFilter("tab", value)}>
          <TabsList>
            {TABS.map((tabItem) => (
              <TabsTrigger
                key={tabItem.value}
                value={tabItem.value}
                indicatorClassName={TAB_INDICATOR[tabItem.value]}
              >
                {tabItem.value === "users" ? (
                  <span className="inline-flex items-center gap-1.5">
                    <UsersIcon className="size-4" aria-hidden />
                    {t(`tabs.${tabItem.value}`)}
                  </span>
                ) : tabItem.value === "me" ? (
                  <span className="inline-flex items-center gap-1.5">
                    <UserIcon className="size-4" aria-hidden />
                    {t(`tabs.${tabItem.value}`)}
                  </span>
                ) : (
                  t(`tabs.${tabItem.value}`)
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {/* Filter bar — every control is server-side now (issue #183): Search, Actor, Action, and the
          range (a relative preset OR an exact from/to). On the My-history tab the Actor select is
          replaced by an inert "You" chip, since the actor is pinned to the caller. */}
      <div
        className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center"
        data-print-hide
      >
        <SearchInput
          value={q}
          debounceMs={250}
          onDebouncedChange={setQ}
          label={t("filters.searchLabel")}
          placeholder={t("filters.searchPlaceholder")}
          className="lg:max-w-xs lg:flex-1"
        />

        {/* Actor filter → actorId. Pinned to "You" on the My-history tab. */}
        {isMyHistory ? (
          <span
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-input px-2.5 text-sm text-muted-foreground"
            title={t("filters.youTitle")}
          >
            <UserIcon className="size-4" aria-hidden />
            {t("filters.you")}
          </span>
        ) : (
          <Select
            value={actorFilter}
            onValueChange={(value) => setFilter("actor", value)}
          >
            <SelectTrigger className="lg:w-56">
              <SelectValue placeholder={t("filters.anyActor")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">{t("filters.anyActor")}</SelectItem>
              {(users ?? []).map((user) => (
                <SelectItem key={user.id} value={user.id}>
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <ActorAvatar
                      name={`${user.firstName} ${user.lastName}`}
                      seed={user.id}
                    />
                    <span className="min-w-0 truncate">
                      {user.firstName} {user.lastName}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Select
          value={actionFilter}
          onValueChange={(value) => setFilter("action", value)}
        >
          <SelectTrigger className="lg:w-48">
            <SelectValue placeholder={t("filters.allActions")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t("filters.allActions")}</SelectItem>
            {RECENT_ACTIVITY_ACTIONS.map((action) => (
              <SelectItem key={action} value={action}>
                {actionLabel(action, tAction)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Relative-range preset: a convenience that writes concrete `from`/`to` dates. */}
        <Select
          value={rangePreset === "custom" ? "all" : rangePreset}
          onValueChange={(value) => {
            const r = presetRange(value as RangeValue, now);
            // Both bounds in one navigation (#217); two setFilter calls would clobber.
            setFilters({ from: r.from, to: r.to });
          }}
        >
          <SelectTrigger className="lg:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {t(`filters.range.${option.value}`)}
              </SelectItem>
            ))}
            {rangePreset === "custom" ? (
              <SelectItem value="custom" disabled>
                {t("filters.range.custom")}
              </SelectItem>
            ) : null}
          </SelectContent>
        </Select>

        {/* Exact range → from/to. Native date inputs (no dep); each writes its `from`/`to` filter,
            which the request converts to a closed-open `[from, to)` ISO window. */}
        <div className="inline-flex items-center gap-1.5 text-sm">
          <input
            type="date"
            aria-label={t("filters.fromDate")}
            value={fromDate}
            max={toDate || undefined}
            onChange={(e) => setFilter("from", e.target.value)}
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <span className="text-muted-foreground">→</span>
          <input
            type="date"
            aria-label={t("filters.toDate")}
            value={toDate}
            min={fromDate || undefined}
            onChange={(e) => setFilter("to", e.target.value)}
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>

        <RowsPerPageSelect
          value={limit}
          onChange={setLimit}
          className="lg:ml-auto lg:w-44"
        />
      </div>

      <div data-print-hide>
        <ActiveFilters chips={chips} onClearAll={clearFilters} />
      </div>

      {isLoading ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <EmptyState
          icon={ClockIcon}
          pillar="access"
          title={t("empty.title")}
          description={
            filtersActive
              ? t("empty.descriptionFiltered")
              : t("empty.description")
          }
        >
          {filtersActive ? (
            <ClearFiltersLink onClick={clearFilters} />
          ) : null}
        </EmptyState>
      ) : (
        <TableView
          items={items}
          offset={offset}
          limit={limit}
          total={total}
          onOffsetChange={setOffset}
          onClearFilters={clearFilters}
        />
      )}
    </div>
  );
}

/**
 * The dense table view, paginated SERVER-SIDE (issue #183): `items` is one server page and `total` is
 * the server's filtered count, so the {@link Pagination} prev/next math is real (not a client slice).
 */
function TableView({
  items,
  offset,
  limit,
  total,
  onOffsetChange,
  onClearFilters,
}: {
  items: RecentActivityItem[];
  offset: number;
  limit: number;
  total: number;
  onOffsetChange: (offset: number) => void;
  onClearFilters: () => void;
}) {
  const t = useTranslations("reports");
  const tAction = useTranslations("shared.activity.action");
  const { dateTime, relative } = useFormatters();
  const columns: ResourceColumn[] = [
    {
      key: "when",
      header: t("table.columns.when"),
      skeleton: <Skeleton className="h-4 w-20" />,
    },
    {
      key: "action",
      header: t("table.columns.action"),
      skeleton: <Skeleton className="h-5 w-20 rounded-full" />,
    },
    {
      key: "entity",
      header: t("table.columns.entity"),
      skeleton: <Skeleton className="h-4 w-16" />,
    },
    {
      key: "actor",
      header: t("table.columns.actor"),
      skeleton: <Skeleton className="h-4 w-24" />,
    },
    {
      key: "summary",
      header: t("table.columns.summary"),
      skeleton: <Skeleton className="h-4 w-48" />,
    },
  ];

  return (
    <>
      <ResourceTable
        columns={columns}
        isFilteredEmpty={items.length === 0}
        filteredEmptyMessage={t("table.filteredEmpty")}
        filteredEmptyAction={<ClearFiltersLink onClick={onClearFilters} />}
        mobileChildren={items.map((item) => {
          const meta = ENTITY_META[item.entityType];
          return (
            <ResourceCard
              key={`${item.entityType}-${item.entityId}-${item.action}-${item.occurredAt}`}
              href={meta.href(item.entityId)}
              title={item.summary}
              badge={
                <StatusBadge tone={actionTone(item.action)}>
                  {actionLabel(item.action, tAction)}
                </StatusBadge>
              }
              meta={
                <>
                  <ResourceCardMeta label={t("table.columns.when")}>
                    <span className="tabular-nums" title={dateTime(item.occurredAt)}>
                      {relative(item.occurredAt)}
                    </span>
                  </ResourceCardMeta>
                  <ResourceCardMeta label={t("table.columns.entity")}>
                    <span>{t(`table.entityLabel.${item.entityType}`)}</span>
                  </ResourceCardMeta>
                  <ResourceCardMeta label={t("table.columns.actor")}>
                    {item.actorName ?? t("table.system")}
                  </ResourceCardMeta>
                </>
              }
            />
          );
        })}
      >
        {items.map((item) => {
          const meta = ENTITY_META[item.entityType];
          const EntityIcon = meta.icon;
          return (
            <LinkableRow
              key={`${item.entityType}-${item.entityId}-${item.action}-${item.occurredAt}`}
              href={meta.href(item.entityId)}
            >
              <TableCell
                className="text-muted-foreground tabular-nums whitespace-nowrap"
                title={dateTime(item.occurredAt)}
              >
                {relative(item.occurredAt)}
              </TableCell>
              <TableCell>
                <StatusBadge tone={actionTone(item.action)}>
                  {actionLabel(item.action, tAction)}
                </StatusBadge>
              </TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-1.5">
                  <EntityIcon
                    className="size-4 text-muted-foreground"
                    aria-hidden
                  />
                  <span>{t(`table.entityLabel.${item.entityType}`)}</span>
                </span>
              </TableCell>
              <TableCell>
                {item.actorName ? (
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <ActorAvatar name={item.actorName} seed={item.actorId} />
                    <span className="min-w-0 truncate">{item.actorName}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">
                    {t("table.system")}
                  </span>
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
        total={total}
        limit={limit}
        offset={offset}
        itemCount={items.length}
        onOffsetChange={onOffsetChange}
      />
    </>
  );
}

const SKELETON_KEYS = ["a", "b", "c", "d", "e"] as const;

/** Loading placeholder shown while the first activity page resolves. */
function TableSkeleton() {
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
