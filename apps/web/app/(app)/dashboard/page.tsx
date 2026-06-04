"use client";

import {
  ArrowPathIcon,
  ArrowRightIcon,
  BookOpenIcon,
  CheckCircleIcon,
  CubeIcon,
  ExclamationTriangleIcon,
  KeyIcon,
  PlusIcon,
  ServerStackIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";
import type { AssetStatus, DashboardSummary } from "@lazyit/shared";
import Link from "next/link";
import type { ComponentType, CSSProperties } from "react";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import type { Pillar } from "@/components/pillar-scope";
import { ErrorState } from "@/components/resource-table";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDashboardSummary } from "@/lib/api/hooks/use-dashboard";
import { useCan } from "@/lib/hooks/use-permissions";
import { lift } from "@/lib/recipes";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/utils/format";
import { formatAssetStatus } from "../assets/_components/asset-status-badge";
import { RecentActivityPanel } from "./_components/recent-activity-panel";

/**
 * Dashboard landing — live metrics across lazyit's three pillars (Inventory / Access / Knowledge).
 * Everything here is read from `GET /dashboard/summary` (a point-in-time aggregation, never a
 * subscription) via `useDashboardSummary`. The view has three states: loading skeletons, a shared
 * `ErrorState` surface, and the loaded metrics. The loaded view leads with "Needs attention", then
 * the per-pillar count cards, then the cross-pillar activity feed. Every metric / attention row
 * deep-links into a PRE-FILTERED list (using the same URL filter params the lists read), and ADMIN
 * callers get quick write actions. No writes happen on this page itself.
 */
export default function DashboardPage() {
  const { data, isLoading, isError, error, refetch, isFetching } =
    useDashboardSummary();
  // The quick actions are cross-pillar shortcuts into create flows; each gates on its own permission.
  const canCreateAsset = useCan("asset:write");
  const canAdjustStock = useCan("consumable:write");
  const canGrantAccess = useCan("accessGrant:grant");
  const showQuickActions = canCreateAsset || canAdjustStock || canGrantAccess;
  // Snapshot "now" once so the "Updated <relative>" stamp stays pure across renders.
  const [now] = useState(() => Date.now());

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        subtitle="Your IT estate at a glance — Inventory, Access and Knowledge."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {data ? (
              <span
                className="text-xs text-muted-foreground tabular-nums"
                title={new Date(data.generatedAt).toLocaleString()}
              >
                Updated {formatRelativeTime(data.generatedAt, now)}
              </span>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <ArrowPathIcon className={cn(isFetching && "animate-spin")} />
              Refresh
            </Button>
          </div>
        }
      />

      {showQuickActions ? (
        <QuickActions
          canCreateAsset={canCreateAsset}
          canAdjustStock={canAdjustStock}
          canGrantAccess={canGrantAccess}
        />
      ) : null}

      {isLoading ? (
        <DashboardSkeleton />
      ) : isError ? (
        <ErrorState
          title="Could not load the dashboard"
          onRetry={() => refetch()}
          error={error}
        />
      ) : data ? (
        <DashboardContent summary={data} />
      ) : null}
    </div>
  );
}

/**
 * Quick write actions — the most common "start something" jumps off the dashboard. Each is shown only
 * when the caller holds the matching permission, so the row honestly reflects what they can do.
 */
function QuickActions({
  canCreateAsset,
  canAdjustStock,
  canGrantAccess,
}: {
  canCreateAsset: boolean;
  canAdjustStock: boolean;
  canGrantAccess: boolean;
}) {
  const actions = (
    [
      { href: "/assets/new", label: "New asset", show: canCreateAsset },
      { href: "/consumables/new", label: "Add stock", show: canAdjustStock },
      { href: "/applications", label: "Grant access", show: canGrantAccess },
    ] as const
  ).filter((action) => action.show);
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((action) => (
        <Button key={action.href} variant="outline" size="sm" asChild>
          <Link href={action.href}>
            <PlusIcon />
            {action.label}
          </Link>
        </Button>
      ))}
    </div>
  );
}

/** The loaded dashboard: the needs-attention zone leads, then pillar cards, then the activity feed. */
function DashboardContent({ summary }: { summary: DashboardSummary }) {
  const { assets, access, consumables, articles } = summary;

  return (
    <div className="space-y-6">
      <NeedsAttention summary={summary} />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <PillarCard
          pillar="inventory"
          index={0}
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
            href: `/assets?status=${status}`,
          }))}
          footer={{
            label: `${assets.assigned} currently assigned`,
            href: "/assets?ownership=HAS",
          }}
        />
        <PillarCard
          pillar="access"
          index={1}
          icon={KeyIcon}
          title="Access"
          metric={access.activeGrants}
          metricLabel={access.activeGrants === 1 ? "active grant" : "active grants"}
          href="/applications"
          cta="Manage access"
          breakdown={[
            {
              label: "On critical apps",
              value: access.onCriticalApps,
              href: "/applications?criticality=CRITICAL",
            },
            {
              label: `Expiring ≤ ${access.expiringWithinDays}d`,
              value: access.expiringSoon,
              href: "/applications",
            },
          ]}
        />
        <PillarCard
          pillar="knowledge"
          index={2}
          icon={BookOpenIcon}
          title="Knowledge"
          metric={articles.total}
          metricLabel={articles.total === 1 ? "article" : "articles"}
          href="/kb"
          cta="Open the knowledge base"
          breakdown={[
            {
              label: "Published",
              value: articles.published,
              href: "/kb?status=PUBLISHED",
            },
            { label: "Drafts", value: articles.draft, href: "/kb?status=DRAFT" },
          ]}
        />
        <PillarCard
          pillar="inventory"
          index={3}
          icon={CubeIcon}
          title="Consumables"
          metric={consumables.total}
          metricLabel={consumables.total === 1 ? "item" : "items"}
          href="/consumables"
          cta="Browse consumables"
          breakdown={[
            {
              label: "Low on stock",
              value: consumables.lowStock,
              href: "/consumables?lowStock=true",
            },
          ]}
        />
      </section>

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
  /** Deep-link into the pre-filtered list for this bucket. */
  href: string;
}

/**
 * Static, scanner-safe tinted-chip classes per pillar (ADR-0049). The chip holds a
 * DECORATIVE glyph (aria-hidden, ≥24px-equivalent) so the pillar hue is safe as both the
 * `/10` tint and the glyph colour — readable text stays on `--foreground`. Each card wears
 * its pillar's identity so the five-hue system is visible on the landing screen: Assets &
 * Consumables = Inventory teal (differentiated by icon), Access = indigo, Knowledge = green.
 * Full strings so the Tailwind v4 scanner keeps them.
 */
const PILLAR_CHIP: Record<Pillar, string> = {
  inventory: "bg-pillar-inventory/10 text-pillar-inventory",
  access: "bg-pillar-access/10 text-pillar-access",
  knowledge: "bg-pillar-knowledge/10 text-pillar-knowledge",
  manage: "bg-pillar-manage/10 text-pillar-manage",
};

/** One pillar's health card: a headline count, a deep-linked breakdown, and a link into the area. */
function PillarCard({
  pillar,
  index,
  icon: Icon,
  title,
  metric,
  metricLabel,
  breakdown,
  footer,
  href,
  cta,
}: {
  /** The pillar whose colour identity this card wears (tinted icon chip). */
  pillar: Pillar;
  /** 0-based mount index, drives the subtle staggered metric rise-in (capped at 4 cards). */
  index: number;
  icon: ComponentType<{ className?: string }>;
  title: string;
  metric: number;
  metricLabel: string;
  breakdown: BreakdownRow[];
  footer?: { label: string; href: string };
  href: string;
  cta: string;
}) {
  return (
    <Card className={cn("h-full", lift)}>
      <CardHeader>
        <div
          className={cn(
            "flex size-9 items-center justify-center rounded-lg",
            PILLAR_CHIP[pillar],
          )}
          aria-hidden
        >
          <Icon className="size-5" />
        </div>
        <CardTitle className="pt-2">{title}</CardTitle>
        <CardDescription>
          {/* Metric settles in on first mount with a subtle, capped stagger (initial-mount
              only; reduced-motion collapses it to instant via the globals.css guard). */}
          <span
            className="inline-block animate-rise-in text-2xl font-semibold tabular-nums text-foreground [animation-delay:calc(var(--i)*60ms)]"
            style={{ "--i": index } as CSSProperties}
          >
            {metric}
          </span>{" "}
          {metricLabel}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <dl className="space-y-0.5 text-sm">
          {breakdown.length === 0 ? (
            <p className="text-muted-foreground">No data yet.</p>
          ) : (
            breakdown.map((row) => (
              <Link
                key={row.label}
                href={row.href}
                className="-mx-1.5 flex items-center justify-between gap-2 rounded px-1.5 py-1 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="font-medium tabular-nums">{row.value}</dd>
              </Link>
            ))
          )}
        </dl>
        {footer ? (
          <Link
            href={footer.href}
            className="-mx-1.5 rounded px-1.5 text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {footer.label}
          </Link>
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
 * lost assets, low-stock consumables, soon-to-expire grants and grants on critical apps. Each row
 * deep-links into the PRE-FILTERED list it describes (same URL filter params the lists read). Items
 * with a zero count are dropped; if nothing needs attention, an all-clear note is shown instead.
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
        href: "/applications?criticality=CRITICAL",
      },
      {
        key: "low-stock",
        icon: CubeIcon,
        label: `${consumables.lowStock} consumable${consumables.lowStock === 1 ? "" : "s"} at or below the reorder threshold`,
        count: consumables.lowStock,
        tone: "warning",
        href: "/consumables?lowStock=true",
      },
      {
        key: "in-maintenance",
        icon: WrenchScrewdriverIcon,
        label: `${inMaintenance} asset${inMaintenance === 1 ? "" : "s"} in maintenance`,
        count: inMaintenance,
        tone: "warning",
        href: "/assets?status=IN_MAINTENANCE",
      },
      {
        key: "lost",
        icon: ExclamationTriangleIcon,
        label: `${lost} asset${lost === 1 ? "" : "s"} marked lost`,
        count: lost,
        tone: "danger",
        href: "/assets?status=LOST",
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
          <CardContent className="flex items-center gap-3 py-6 text-sm">
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-success/10 text-success"
              aria-hidden
            >
              <CheckCircleIcon className="size-5" />
            </span>
            <span className="text-foreground">
              All clear — no expiring grants, low stock or lost assets right now.
            </span>
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

// Semantic status tokens (ADR-0049): the warning/danger states drive off --warning /
// --destructive, which carry dark-mode parity — so the hand-written amber/rose palette
// values (and their missing dark variants) are gone. `pulse` marks the one tone (danger)
// whose dot gets the calm `pulse-soft` heartbeat — urgency felt, not alarmed.
const TONE: Record<AttentionTone, { dot: string; ring: string; pulse: boolean }> =
  {
    warning: { dot: "bg-warning", ring: "ring-warning/25", pulse: false },
    danger: { dot: "bg-destructive", ring: "ring-destructive/30", pulse: true },
  };

// Tone-aware lift: the signature hover triad (rise + e1→e2 shadow), but the resting ring is
// the row's TONE ring (warning/danger), not the generic foreground/10 — so we borrow the
// motion half of the `lift` recipe and keep the tone ring as the colour identity.
const ATTENTION_LIFT =
  "shadow-e1 transition-[transform,box-shadow,background-color] duration-[var(--dur-base)] ease-[var(--ease-out-quad)] hover:-translate-y-0.5 hover:shadow-e2 motion-reduce:transition-none";

function AttentionRow({ item }: { item: AttentionItem }) {
  const { icon: Icon, label, count, tone, href } = item;
  const meta = TONE[tone];
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-3 rounded-lg border p-3 text-sm outline-none ring-1 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring",
        meta.ring,
        ATTENTION_LIFT,
      )}
    >
      <span className="relative flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" />
        <span
          className={cn(
            "absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-card",
            meta.dot,
            meta.pulse && "animate-pulse-soft",
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

/**
 * Loading placeholder mirroring the needs-attention zone + the four pillar cards. The
 * `animate-shimmer` sweep is composed over each Skeleton's muted fill at the call site (the
 * vendored Skeleton primitive stays untouched); reduced-motion stills the sweep globally.
 */
function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-6 w-40 animate-shimmer" />
        <div className="grid gap-3 sm:grid-cols-2">
          {SKELETON_ATTENTION_KEYS.map((key) => (
            <Skeleton key={key} className="h-14 w-full rounded-lg animate-shimmer" />
          ))}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {SKELETON_PILLAR_KEYS.map((key) => (
          <Card key={key} className="h-full">
            <CardHeader>
              <Skeleton className="size-9 rounded-lg animate-shimmer" />
              <Skeleton className="mt-2 h-5 w-24 animate-shimmer" />
              <Skeleton className="h-7 w-20 animate-shimmer" />
            </CardHeader>
            <CardContent className="space-y-2">
              <Skeleton className="h-4 w-full animate-shimmer" />
              <Skeleton className="h-4 w-3/4 animate-shimmer" />
              <Skeleton className="mt-2 h-4 w-28 animate-shimmer" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
