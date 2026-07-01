"use client";

import {
  ArrowDownTrayIcon,
  ShieldCheckIcon,
  PrinterIcon,
} from "@heroicons/react/24/outline";
import {
  AUDIT_ACTIONS_BY_SOURCE,
  AUDIT_LOG_SOURCES,
  type AuditLogItem,
  type AuditLogSource,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { ActorAvatar } from "@/components/activity-row";
import { ActiveFilters, ClearFiltersLink } from "@/components/active-filters";
import { Breadcrumb } from "@/components/breadcrumb";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { RowsPerPageSelect } from "@/components/rows-per-page-select";
import { ErrorState, Pagination } from "@/components/resource-table";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AuditLogClientFilters } from "@/lib/api/endpoints/audit";
import { useAuditLogFilters, useAuditLogsPage } from "@/lib/api/hooks/use-audit";
import { notifyError } from "@/lib/api/notify-error";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useListParams } from "@/lib/hooks/use-list-params";
import { downloadAuditExport, downloadVisibleAuditCsv } from "./audit-csv";

/** Stable empty breadcrumb for the audit PageHeader. */
const BREADCRUMB = <Breadcrumb />;

const FILTER_DEFAULTS = {
  source: "secret" as AuditLogSource,
  action: "ALL",
  actor: "ALL",
  // Date-only (`YYYY-MM-DD`) URL filters; empty means that bound is open.
  from: "",
  to: "",
  // Deep-linkable soft-ref filters (the per-vault / per-item / per-SA timeline). Set via URL params.
  vaultId: "",
  itemId: "",
  serviceAccountId: "",
} as const;

/** Underline tint per source tab (token-backed). */
const SOURCE_INDICATOR: Record<AuditLogSource, string> = {
  secret: "data-[state=active]:border-pillar-manage",
  permission: "data-[state=active]:border-primary",
  serviceAccount: "data-[state=active]:border-pillar-access",
};

/** Start-of-day local ISO for a `YYYY-MM-DD`, or undefined when empty/invalid. */
function fromDateToIso(date: string): string | undefined {
  if (!date) return undefined;
  const d = new Date(`${date}T00:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Exclusive upper-bound ISO for a `YYYY-MM-DD` (start of the following day) — closed-open `[from, to)`. */
function toDateToIso(date: string): string | undefined {
  if (!date) return undefined;
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return undefined;
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

/**
 * Humanize a raw uppercase action label (e.g. `VAULT_CREATED` → "Vault created", `ITEM_REVEALED` →
 * "Item revealed"). Locale-neutral title-case of the enum token.
 *
 * ponytail: humanize in-place instead of a per-locale label map (~22 keys × 2 locales). CEILING: the
 * chip reads the same de-snaked English in both locales; the action VALUE is a technical enum token, so
 * this is acceptable for v1 — add `audit.action.*` i18n keys if a translated label is ever wanted.
 */
function auditActionLabel(action: string): string {
  const words = action.replace(/_/g, " ").toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A StatusBadge tone for an audit action, by the verb's "shape" (additive / removing / sensitive). */
function auditActionTone(action: string): StatusTone {
  if (/(CREATED|GRANTED|MINT|RESTORE|CHANGED)$/.test(action)) return "success";
  if (/(DELETED|REVOKED|REVOKE)$/.test(action)) return "danger";
  if (/(REVEALED|FETCHED|EXPORTED|RESET|ROTATE)$/.test(action)) return "warning";
  return "info";
}

export function AuditScreen() {
  const t = useTranslations("audit");
  const [isExportingAll, setIsExportingAll] = useState(false);
  const { limit, offset, filters, setFilter, setFilters, setLimit, setOffset, clearFilters, filtersActive } =
    useListParams({ filters: FILTER_DEFAULTS, defaultLimit: 25 });

  const source = (filters.source as AuditLogSource) ?? "secret";
  const actionFilter = filters.action;
  const actorFilter = filters.actor;
  const fromDate = filters.from;
  const toDate = filters.to;
  const vaultId = filters.vaultId;
  const itemId = filters.itemId;
  const serviceAccountId = filters.serviceAccountId;

  // Action options are ENUM-DRIVEN from the shared per-source enum (so #870's ITEM_REVEALED, or any new
  // DB enum value, appears automatically — no frontend edit).
  const actionOptions = AUDIT_ACTIONS_BY_SOURCE[source];
  // The actor select's menu — only the people who actually produced a row for this source.
  const { data: filterOptions } = useAuditLogFilters(source);
  const actorOptions = filterOptions?.actors ?? [];

  // Map URL filter state → the server request filters.
  const serverFilters = useMemo<AuditLogClientFilters>(() => {
    const out: AuditLogClientFilters = {};
    if (
      actionFilter !== "ALL" &&
      (actionOptions as readonly string[]).includes(actionFilter)
    ) {
      out.action = actionFilter;
    }
    if (actorFilter !== "ALL") out.actorId = actorFilter;
    if (source !== "permission" && serviceAccountId) {
      out.serviceAccountId = serviceAccountId;
    }
    if (source === "secret") {
      if (vaultId) out.vaultId = vaultId;
      if (itemId) out.itemId = itemId;
    }
    const fromIso = fromDateToIso(fromDate);
    const toIso = toDateToIso(toDate);
    if (fromIso) out.from = fromIso;
    if (toIso) out.to = toIso;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    source,
    actionFilter,
    actorFilter,
    serviceAccountId,
    vaultId,
    itemId,
    fromDate,
    toDate,
  ]);

  const {
    data: pageData,
    isLoading,
    isError,
    error,
    refetch,
  } = useAuditLogsPage(source, limit, offset, serverFilters);

  const items = pageData?.items ?? [];
  const total = pageData?.total ?? 0;

  async function handleExportAll() {
    setIsExportingAll(true);
    try {
      await downloadAuditExport(source, serverFilters);
    } catch (err) {
      notifyError(err, t("export.exportAllError"));
    } finally {
      setIsExportingAll(false);
    }
  }

  const chips = [
    ...(actionFilter !== "ALL"
      ? [
          {
            key: "action",
            label: t("filters.chips.action", { value: auditActionLabel(actionFilter) }),
            onClear: () => setFilter("action", FILTER_DEFAULTS.action),
          },
        ]
      : []),
    ...(actorFilter !== "ALL"
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
    ...(source === "secret" && vaultId
      ? [
          {
            key: "vault",
            label: t("filters.chips.vault", { value: vaultId }),
            onClear: () => setFilter("vaultId", FILTER_DEFAULTS.vaultId),
          },
        ]
      : []),
    ...(source === "secret" && itemId
      ? [
          {
            key: "item",
            label: t("filters.chips.item", { value: itemId }),
            onClear: () => setFilter("itemId", FILTER_DEFAULTS.itemId),
          },
        ]
      : []),
    ...(source !== "permission" && serviceAccountId
      ? [
          {
            key: "sa",
            label: t("filters.chips.serviceAccount", { value: serviceAccountId }),
            onClear: () =>
              setFilter("serviceAccountId", FILTER_DEFAULTS.serviceAccountId),
          },
        ]
      : []),
    ...(fromDate || toDate
      ? [
          {
            key: "range",
            label: t("filters.chips.rangeCustom", {
              from: fromDate || "…",
              to: toDate || "…",
            }),
            onClear: () =>
              setFilters({ from: FILTER_DEFAULTS.from, to: FILTER_DEFAULTS.to }),
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
            {isExportingAll ? t("export.exportAllBusy") : t("export.exportAll")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => downloadVisibleAuditCsv(source, items)}
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
        <ErrorState title={t("empty.errorTitle")} onRetry={() => refetch()} error={error} />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-print-document>
      {header}

      {/* Source tabs — which of the three security logs to read. Switching source resets the action
          filter (a permission action isn't valid for a secret source) to avoid a stuck empty list. */}
      <div data-print-hide>
        <Tabs
          value={source}
          onValueChange={(value) =>
            setFilters({ source: value, action: FILTER_DEFAULTS.action })
          }
        >
          <TabsList>
            {AUDIT_LOG_SOURCES.map((src) => (
              <TabsTrigger
                key={src}
                value={src}
                indicatorClassName={SOURCE_INDICATOR[src]}
              >
                {t(`sources.${src}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {/* Filter bar — action (enum-driven), actor, and an exact date range. */}
      <div
        className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center"
        data-print-hide
      >
        <Select value={actorFilter} onValueChange={(v) => setFilter("actor", v)}>
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

        <Select value={actionFilter} onValueChange={(v) => setFilter("action", v)}>
          <SelectTrigger className="lg:w-56">
            <SelectValue placeholder={t("filters.allActions")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t("filters.allActions")}</SelectItem>
            {actionOptions.map((action) => (
              <SelectItem key={action} value={action}>
                {auditActionLabel(action)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

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

        <RowsPerPageSelect value={limit} onChange={setLimit} className="lg:ml-auto lg:w-44" />
      </div>

      <div data-print-hide>
        <ActiveFilters chips={chips} onClearAll={clearFilters} />
      </div>

      {isLoading ? (
        <TableSkeleton />
      ) : items.length === 0 ? (
        <EmptyState
          icon={ShieldCheckIcon}
          pillar="manage"
          title={t("empty.title")}
          description={
            filtersActive ? t("empty.descriptionFiltered") : t("empty.description")
          }
        >
          {filtersActive ? <ClearFiltersLink onClick={clearFilters} /> : null}
        </EmptyState>
      ) : (
        <AuditTape
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
 * The audit feed as a LEDGER TAPE (ADR-0077): one hairline-ruled record per row — a mono/tabular
 * timestamp · the actor (human, or a service account, or "system") · the ACTION stamp · a source-
 * specific detail line (metadata only). Server-paginated (true prev/next). The append-only row `id` is
 * a stable, unique key.
 */
function AuditTape({
  items,
  offset,
  limit,
  total,
  onOffsetChange,
}: {
  items: AuditLogItem[];
  offset: number;
  limit: number;
  total: number;
  onOffsetChange: (offset: number) => void;
}) {
  const t = useTranslations("audit");
  const { dateTime, relative } = useFormatters();

  return (
    <>
      <ul className="divide-y divide-border">
        {items.map((item) => {
          const actor = item.actorName ?? item.serviceAccountName;
          return (
            <li
              key={item.id}
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
                {actor ? (
                  <>
                    <ActorAvatar name={actor} seed={item.actorId ?? item.serviceAccountId} />
                    <span className="min-w-0 truncate">{actor}</span>
                  </>
                ) : (
                  <span>{t("table.system")}</span>
                )}
              </span>
              <StatusBadge tone={auditActionTone(item.action)}>
                {auditActionLabel(item.action)}
              </StatusBadge>
              <span className="inline-flex min-w-0 flex-1 items-baseline gap-1.5">
                <span aria-hidden className="font-mono text-muted-foreground/60">
                  →
                </span>
                <span className="min-w-0 truncate">{detailLine(item, t)}</span>
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

/** A source-specific one-line detail for a row (metadata only — never a value). */
function detailLine(item: AuditLogItem, t: ReturnType<typeof useTranslations>): string {
  switch (item.source) {
    case "secret": {
      const parts = [item.vaultName, item.itemLabel].filter(Boolean);
      const subject = parts.join(" / ") || t("table.noSubject");
      const target = item.targetUserName ?? item.targetServiceAccountName;
      return target ? `${subject} · ${target}` : subject;
    }
    case "permission":
      return [item.role, item.permission].filter(Boolean).join(" · ") || t("table.noSubject");
    case "serviceAccount":
      return (
        [item.serviceAccountName, item.detail].filter(Boolean).join(" · ") ||
        t("table.noSubject")
      );
  }
}

const SKELETON_KEYS = ["a", "b", "c", "d", "e"] as const;

/** Loading placeholder shaped like the ledger tape so the skeleton→loaded swap doesn't reflow. */
function TableSkeleton() {
  return (
    <ul className="divide-y divide-border">
      {SKELETON_KEYS.map((key) => (
        <li key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
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
