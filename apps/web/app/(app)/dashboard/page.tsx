"use client";

import {
  ArrowRightIcon,
  BookOpenIcon,
  CubeIcon,
  ExclamationTriangleIcon,
  KeyIcon,
  ServerStackIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";
import type { AssetStatus, DashboardSummary } from "@lazyit/shared";
import Link from "next/link";
import type { ComponentType, ReactNode } from "react";
import { RequestIdNote } from "@/components/request-id-note";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api/client";
import { useDashboardSummary } from "@/lib/api/hooks/use-dashboard";
import { cn } from "@/lib/utils";
import { formatAssetStatus } from "../assets/_components/asset-status-badge";
import { RecentActivityPanel } from "./_components/recent-activity-panel";

/**
 * Dashboard landing — live metrics across lazyit's three pillars (Inventory / Access / Knowledge).
 * Everything here is read from `GET /dashboard/summary` (a point-in-time aggregation, never a
 * subscription) via `useDashboardSummary`. The view has three states: loading skeletons, an error
 * surface (with the API request id for reporting), and the loaded metrics + a "Needs attention"
 * zone that highlights anything operationally noteworthy. No writes happen here.
 */
export default function DashboardPage() {
  const { data, isLoading, isError, error, refetch } = useDashboardSummary();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Your IT estate at a glance — Inventory, Access and Knowledge.
        </p>
      </div>

      {isLoading ? (
        <DashboardSkeleton />
      ) : isError ? (
        <DashboardError error={error} onRetry={() => refetch()} />
      ) : data ? (
        <DashboardContent summary={data} />
      ) : null}
    </div>
  );
}

/** The loaded dashboard: pillar health cards + the needs-attention zone. */
function DashboardContent({ summary }: { summary: DashboardSummary }) {
  const { assets, access, consumables, articles } = summary;

  return (
    <div className="space-y-6">
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <PillarCard
          icon={ServerStackIcon}
          title="Assets"
          metric={assets.total}
          metricLabel={assets.total === 1 ? "asset" : "assets"}
          href="/assets"
          cta="Browse assets"
          breakdown={ASSET_STATUS_ORDER.filter(
            (status) => (assets.byStatus[status] ?? 0) > 0,
          ).map((status) => ({
            label: formatAssetStatus(status),
            value: assets.byStatus[status] ?? 0,
          }))}
          footer={`${assets.assigned} currently assigned`}
        />
        <PillarCard
          icon={KeyIcon}
          title="Access"
          metric={access.activeGrants}
          metricLabel={access.activeGrants === 1 ? "active grant" : "active grants"}
          href="/applications"
          cta="Manage access"
          breakdown={[
            { label: "On critical apps", value: access.onCriticalApps },
            {
              label: `Expiring ≤ ${access.expiringWithinDays}d`,
              value: access.expiringSoon,
            },
          ]}
        />
        <PillarCard
          icon={BookOpenIcon}
          title="Knowledge"
          metric={articles.total}
          metricLabel={articles.total === 1 ? "article" : "articles"}
          href="/kb"
          cta="Open the knowledge base"
          breakdown={[
            { label: "Published", value: articles.published },
            { label: "Drafts", value: articles.draft },
          ]}
        />
        <PillarCard
          icon={CubeIcon}
          title="Consumables"
          metric={consumables.total}
          metricLabel={consumables.total === 1 ? "item" : "items"}
          href="/consumables"
          cta="Browse consumables"
          breakdown={[{ label: "Low on stock", value: consumables.lowStock }]}
        />
      </section>

      <NeedsAttention summary={summary} />

      <RecentActivityPanel />
    </div>
  );
}

/** The status buckets, in a fixed lifecycle order, so the breakdown renders stably. */
const ASSET_STATUS_ORDER: AssetStatus[] = [
  "OPERATIONAL",
  "IN_MAINTENANCE",
  "IN_STORAGE",
  "RETIRED",
  "LOST",
  "UNKNOWN",
];

interface BreakdownRow {
  label: string;
  value: number;
}

/** One pillar's health card: a headline count, a small breakdown, and a link into the area. */
function PillarCard({
  icon: Icon,
  title,
  metric,
  metricLabel,
  breakdown,
  footer,
  href,
  cta,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  metric: number;
  metricLabel: string;
  breakdown: BreakdownRow[];
  footer?: string;
  href: string;
  cta: string;
}) {
  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-5" />
        </div>
        <CardTitle className="pt-2">{title}</CardTitle>
        <CardDescription>
          <span className="text-2xl font-semibold tabular-nums text-foreground">
            {metric}
          </span>{" "}
          {metricLabel}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <dl className="space-y-1.5 text-sm">
          {breakdown.length === 0 ? (
            <p className="text-muted-foreground">No data yet.</p>
          ) : (
            breakdown.map((row) => (
              <div
                key={row.label}
                className="flex items-center justify-between gap-2"
              >
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="font-medium tabular-nums">{row.value}</dd>
              </div>
            ))
          )}
        </dl>
        {footer ? (
          <p className="text-xs text-muted-foreground">{footer}</p>
        ) : null}
        <Link
          href={href}
          className="mt-auto inline-flex items-center gap-1.5 pt-1 text-sm font-medium text-primary outline-none hover:underline focus-visible:underline"
        >
          {cta}
          <ArrowRightIcon className="size-4" />
        </Link>
      </CardContent>
    </Card>
  );
}

type AttentionTone = "warning" | "danger";

interface AttentionItem {
  key: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  count: number;
  tone: AttentionTone;
  href: string;
}

/**
 * "Needs attention" zone — the operationally noteworthy subset of the summary: in-maintenance and
 * lost assets, low-stock consumables, soon-to-expire grants and grants on critical apps. Items with
 * a zero count are dropped; if nothing needs attention, an all-clear note is shown instead. (The
 * summary contract carries no warranty-expiry figure, so that signal is not surfaced here.)
 */
function NeedsAttention({ summary }: { summary: DashboardSummary }) {
  const { assets, access, consumables } = summary;

  const inMaintenance = assets.byStatus.IN_MAINTENANCE ?? 0;
  const lost = assets.byStatus.LOST ?? 0;

  const items: AttentionItem[] = (
    [
      {
        key: "expiring-grants",
        icon: KeyIcon,
        label: `${access.expiringSoon} grant${access.expiringSoon === 1 ? "" : "s"} expiring within ${access.expiringWithinDays} days`,
        count: access.expiringSoon,
        tone: "warning",
        href: "/applications",
      },
      {
        key: "critical-grants",
        icon: KeyIcon,
        label: `${access.onCriticalApps} active grant${access.onCriticalApps === 1 ? "" : "s"} on critical applications`,
        count: access.onCriticalApps,
        tone: "warning",
        href: "/applications",
      },
      {
        key: "low-stock",
        icon: CubeIcon,
        label: `${consumables.lowStock} consumable${consumables.lowStock === 1 ? "" : "s"} at or below the reorder threshold`,
        count: consumables.lowStock,
        tone: "warning",
        href: "/consumables",
      },
      {
        key: "in-maintenance",
        icon: WrenchScrewdriverIcon,
        label: `${inMaintenance} asset${inMaintenance === 1 ? "" : "s"} in maintenance`,
        count: inMaintenance,
        tone: "warning",
        href: "/assets",
      },
      {
        key: "lost",
        icon: ExclamationTriangleIcon,
        label: `${lost} asset${lost === 1 ? "" : "s"} marked lost`,
        count: lost,
        tone: "danger",
        href: "/assets",
      },
    ] satisfies AttentionItem[]
  ).filter((item) => item.count > 0);

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold tracking-tight">
        Needs attention
      </h2>
      {items.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            Nothing needs attention right now — no expiring grants, low stock or
            lost assets.
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {items.map((item) => (
            <li key={item.key}>
              <AttentionRow item={item} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const TONE: Record<AttentionTone, { dot: string; ring: string }> = {
  warning: { dot: "bg-amber-500", ring: "ring-amber-500/20" },
  danger: { dot: "bg-rose-500", ring: "ring-rose-500/30" },
};

function AttentionRow({ item }: { item: AttentionItem }) {
  const { icon: Icon, label, count, tone, href } = item;
  const meta = TONE[tone];
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-3 rounded-lg border p-3 text-sm outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring",
        meta.ring,
      )}
    >
      <span className="relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" />
        <span
          className={cn(
            "absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-card",
            meta.dot,
          )}
        />
      </span>
      <span className="flex-1">{label}</span>
      <span className="text-base font-semibold tabular-nums">{count}</span>
      <ArrowRightIcon className="size-4 text-muted-foreground" />
    </Link>
  );
}

const SKELETON_PILLAR_KEYS = ["a", "b", "c", "d"] as const;
const SKELETON_ATTENTION_KEYS = ["a", "b"] as const;

/** Loading placeholder mirroring the four pillar cards + the needs-attention zone. */
function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {SKELETON_PILLAR_KEYS.map((key) => (
          <Card key={key} className="h-full">
            <CardHeader>
              <Skeleton className="size-9 rounded-lg" />
              <Skeleton className="mt-2 h-5 w-24" />
              <Skeleton className="h-7 w-20" />
            </CardHeader>
            <CardContent className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="mt-2 h-4 w-28" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <div className="grid gap-3 sm:grid-cols-2">
          {SKELETON_ATTENTION_KEYS.map((key) => (
            <Skeleton key={key} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Error surface for the summary fetch, with the API request id for reporting (ADR-0031). */
function DashboardError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}): ReactNode {
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
        <div className="flex size-11 items-center justify-center rounded-full bg-muted">
          <ExclamationTriangleIcon className="size-5 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">Could not load the dashboard</p>
          <p className="text-sm text-muted-foreground">
            The API may be down or unreachable.
          </p>
        </div>
        <RequestIdNote requestId={requestId} />
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border px-3 py-1.5 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        >
          Retry
        </button>
      </CardContent>
    </Card>
  );
}
