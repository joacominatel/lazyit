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
import { ErrorState, Pagination } from "@/components/resource-table";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { actionLabel, actionTone } from "@/lib/activity-tones";
import type { DashboardActivityFilters } from "@/lib/api/endpoints/dashboard";
import { notifyError } from "@/lib/api/notify-error";
import {
  useReportsActivityFilters,
  useReportsActivityPage,
} from "@/lib/api/hooks/use-dashboard";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useListParams } from "@/lib/hooks/use-list-params";
import { downloadActivityExport, downloadCsv } from "./reports-csv";

/** Stable empty breadcrumb for the reports PageHeader (no items — just the home crumb). */
const BREADCRUMB = <Breadcrumb />;

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
 * The feed is rendered as a LEDGER TAPE (ADR-0077): one hairline-ruled, baseline-aligned record per
 * row (mono+tabular timestamp · actor · ACTION stamp · → target · `// <entity>`), with true
 * server-side prev/next paging; the earlier Timeline and dense-Table views were dropped (#696). CSV +
 * Print export exactly the rows currently visible.
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
  // Bulk "export all (filtered)" is async (it streams the whole range from the API); disable while busy.
  const [isExportingAll, setIsExportingAll] = useState(false);
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

  // The actor/action filter MENUS (issue #718): only the actors + actions that actually produced an
  // activity row, not the whole directory / the full static action allowlist.
  const { data: filterOptions } = useReportsActivityFilters();
  const actorOptions = filterOptions?.actors ?? [];
  // Until the menu loads, offer nothing (the "All actions"/"Any actor" reset is always present); a
  // brief empty list beats flashing the full static allowlist that #718 is removing.
  const actionOptions = filterOptions?.actions ?? [];

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

  // Stream the WHOLE filtered range from the API (issue #840), not just the visible page. Uses the same
  // server filters the feed is showing, so "export all" matches what's on screen minus the paging.
  async function handleExportAll() {
    setIsExportingAll(true);
    try {
      await downloadActivityExport(serverFilters);
    } catch (error) {
      notifyError(error, t("export.exportAllError"));
    } finally {
      setIsExportingAll(false);
    }
  }

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
              value:
                actorOptions.find((a) => a.id === actorFilter)?.name ??
                t("filters.selectedUser"),
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
      breadcrumb={BREADCRUMB}
      subtitle={t("page.subtitle")}
      actions={
        <div className="flex items-center gap-2" data-print-hide>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportAll}
            disabled={isExportingAll || total === 0}
            title={t("export.exportAllTitle")}
          >
            <ArrowDownTrayIcon />
            {isExportingAll
              ? t("export.exportAllBusy")
              : t("export.exportAll")}
          </Button>
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
              {actorOptions.map((actor) => (
                <SelectItem key={actor.id} value={actor.id}>
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <ActorAvatar name={actor.name} seed={actor.id} />
                    <span className="min-w-0 truncate">{actor.name}</span>
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
            {actionOptions.map((action) => (
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
}: {
  items: RecentActivityItem[];
  offset: number;
  limit: number;
  total: number;
  onOffsetChange: (offset: number) => void;
}) {
  const t = useTranslations("reports");
  const tAction = useTranslations("shared.activity.action");
  const { dateTime, relative } = useFormatters();

  return (
    <>
      {/* The audit feed as a LEDGER TAPE (ADR-0077): one hairline-ruled record per row, folding
          the former dense table (and its mobile cards) into a single responsive register line —
          the timestamp in Commit Mono tabular figures (locks into a column) · the actor · the
          ACTION stamp · → the target record · a `// <entity>` annotation. Baseline-aligned like a
          printed line; the server paging, filters and links are untouched. The `recent_activity`
          view is a UNION ALL with no unique row id, so two rows can share (entityType, entityId,
          action, occurredAt-to-the-ms) — e.g. an asset with multiple assignments created in the
          same transaction (#719); the page is read-only and paginated, so the map index is a safe
          tiebreaker in the key.
          ponytail: index-in-key (rung 5, one line) — the proper fix (a stable per-row id in the
          view) needs a migration + a widened wire type; not worth it for a read-only list. */}
      <ul className="divide-y divide-border">
        {items.map((item, i) => {
          const meta = ENTITY_META[item.entityType];
          const EntityIcon = meta.icon;
          return (
            <li
              key={`${item.entityType}-${item.entityId}-${item.action}-${item.occurredAt}-${i}`}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5 text-sm first:pt-0 last:pb-0"
            >
              <time
                dateTime={item.occurredAt}
                className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
                title={dateTime(item.occurredAt)}
              >
                {relative(item.occurredAt)}
              </time>
              <span className="inline-flex shrink-0 items-center gap-1.5 text-muted-foreground">
                {item.actorName ? (
                  <>
                    <ActorAvatar name={item.actorName} seed={item.actorId} />
                    <span className="min-w-0 truncate">{item.actorName}</span>
                  </>
                ) : (
                  <span>{t("table.system")}</span>
                )}
              </span>
              <StatusBadge tone={actionTone(item.action)}>
                {actionLabel(item.action, tAction)}
              </StatusBadge>
              <span className="inline-flex min-w-0 flex-1 items-baseline gap-1.5">
                <span aria-hidden className="font-mono text-muted-foreground/60">
                  →
                </span>
                <EntityIcon
                  className="size-4 shrink-0 self-center text-muted-foreground"
                  aria-hidden
                />
                <Link
                  href={meta.href(item.entityId)}
                  className="min-w-0 truncate font-medium hover:underline"
                  title={item.summary}
                >
                  {item.summary}
                </Link>
              </span>
              <span className="shrink-0 text-muted-foreground">
                <span aria-hidden className="font-mono text-muted-foreground/60">
                  {"// "}
                </span>
                {t(`table.entityLabel.${item.entityType}`)}
              </span>
            </li>
          );
        })}
      </ul>

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

/** Loading placeholder shown while the first activity page resolves — shaped like the ledger tape
 *  (hairline rows, a mono-width time stub, an avatar, the rounded-sm action stamp) so the
 *  skeleton→loaded swap doesn't reflow. */
function TableSkeleton() {
  return (
    <ul className="divide-y divide-border">
      {SKELETON_KEYS.map((key) => (
        <li
          key={key}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5"
        >
          <Skeleton className="h-3.5 w-16 shrink-0 animate-shimmer" />
          <Skeleton className="size-6 shrink-0 rounded-full animate-shimmer" />
          <Skeleton className="h-3.5 w-24 shrink-0 animate-shimmer" />
          <Skeleton className="h-5 w-16 shrink-0 rounded-sm animate-shimmer" />
          <Skeleton className="h-3.5 flex-1 animate-shimmer" />
        </li>
      ))}
    </ul>
  );
}
