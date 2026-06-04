"use client";

import {
  ArrowPathIcon,
  ArrowRightIcon,
  BookOpenIcon,
  CheckCircleIcon,
  CubeIcon,
  ExclamationTriangleIcon,
  KeyIcon,
  ServerStackIcon,
  WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";
import type { AssetStatus, DashboardSummary } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import type { ComponentType, CSSProperties, ReactNode } from "react";
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
import { PulseRail, type QuickAction } from "./_components/pulse-rail";
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
  const t = useTranslations("dashboard");
  const tc = useTranslations("common");
  const { data, isLoading, isError, error, refetch, isFetching } =
    useDashboardSummary();
  // The quick actions are cross-pillar shortcuts into create flows; each gates on its own
  // permission. They now live in the Pulse rail's action tile (Wave 3a), so the page resolves
  // the permitted set here and hands it down rather than rendering its own action row.
  const canCreateAsset = useCan("asset:write");
  const canAdjustStock = useCan("consumable:write");
  const canGrantAccess = useCan("accessGrant:grant");
  // The cross-pillar Recent Activity feed is the "who-did-what" stream — sensitive, so it is
  // ADMIN-only via `logs:read` (issue #179), the SAME gate as the Reports/Informes screen.
  // Fail-closed (`useCan` returns false while the permission set is loading / on error), so the
  // feed never flashes for a non-admin. v1 NOTE: this is a UI-LEVEL gate only — the underlying
  // `GET /dashboard/activity` endpoint still authorises on `dashboard:read` (visible to every
  // role), so an admin-only `logs:read` endpoint is DEBT-1, tracked with the Informes screen.
  const canSeeActivityFeed = useCan("logs:read");
  const quickActions = (
    [
      {
        href: "/assets/new",
        label: t("quickActions.newAsset"),
        show: canCreateAsset,
      },
      {
        href: "/consumables/new",
        label: t("quickActions.addStock"),
        show: canAdjustStock,
      },
      {
        href: "/applications",
        label: t("quickActions.grantAccess"),
        show: canGrantAccess,
      },
    ] as const
  )
    .filter((action) => action.show)
    .map(({ href, label }) => ({ href, label }));
  // Snapshot "now" once so the "Updated <relative>" stamp stays pure across renders.
  const [now] = useState(() => Date.now());

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {data ? (
              <span
                className="text-xs text-muted-foreground tabular-nums"
                title={new Date(data.generatedAt).toLocaleString()}
              >
                {t("updated", {
                  relative: formatRelativeTime(data.generatedAt, now),
                })}
              </span>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <ArrowPathIcon className={cn(isFetching && "animate-spin")} />
              {tc("refresh")}
            </Button>
          </div>
        }
      />

      {isLoading ? (
        <DashboardSkeleton canSeeActivityFeed={canSeeActivityFeed} />
      ) : isError ? (
        <ErrorState
          title={t("errorTitle")}
          onRetry={() => refetch()}
          error={error}
        />
      ) : data ? (
        <DashboardContent
          summary={data}
          quickActions={quickActions}
          canSeeActivityFeed={canSeeActivityFeed}
        />
      ) : null}
    </div>
  );
}

/**
 * The loaded dashboard (Wave 3a — two-column command surface). The "at-a-glance" layer leads
 * full-width — Needs Attention, then the four pillar cards. Below the command surface adapts to
 * the caller's `logs:read` (issue #179):
 *   - ADMIN (`canSeeActivityFeed`): the original two-column grid — the Recent Activity feed (~3/5)
 *     beside a sticky Pulse rail (~2/5), the rail reflowing under the feed below `lg`.
 *   - non-admin (no `logs:read`): the sensitive who-did-what feed is hidden, so instead of a lone
 *     2/5 column the SAME three Pulse widgets reflow into a full-width horizontal band (donut ·
 *     access-health · quick-actions), stacking on mobile — an intentional surface, not a stub.
 * Both paths consume the SAME summary snapshot (zero extra fetch — `/dashboard/summary` stays
 * `dashboard:read`, visible to every role) and the resolved quick-actions set; only the feed is
 * gated, and the all-clear reassurance stays owned by the Needs-attention zone above.
 */
function DashboardContent({
  summary,
  quickActions,
  canSeeActivityFeed,
}: {
  summary: DashboardSummary;
  quickActions: QuickAction[];
  /** Whether the caller holds `logs:read` and so may see the cross-pillar activity feed. */
  canSeeActivityFeed: boolean;
}) {
  const t = useTranslations("dashboard");
  const { assets, access, consumables, articles } = summary;

  return (
    <div className="space-y-6">
      <NeedsAttention summary={summary} />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <PillarCard
          pillar="inventory"
          index={0}
          icon={ServerStackIcon}
          title={t("pillars.assets.title")}
          metric={assets.total}
          metricLabel={t("pillars.assets.metricLabel", { count: assets.total })}
          href="/assets"
          cta={t("pillars.assets.cta")}
          breakdown={ASSET_STATUS_ORDER.filter(
            (status) => (assets.byStatus[status] ?? 0) > 0,
          ).map((status) => ({
            label: formatAssetStatus(status),
            value: assets.byStatus[status] ?? 0,
            href: `/assets?status=${status}`,
          }))}
          extra={
            <AssetHealthBar byStatus={assets.byStatus} total={assets.total} />
          }
          footer={{
            label: t("pillars.assets.assignedFooter", {
              count: assets.assigned,
            }),
            href: "/assets?ownership=HAS",
          }}
        />
        <PillarCard
          pillar="access"
          index={1}
          icon={KeyIcon}
          title={t("pillars.access.title")}
          metric={access.activeGrants}
          metricLabel={t("pillars.access.metricLabel", {
            count: access.activeGrants,
          })}
          href="/applications"
          cta={t("pillars.access.cta")}
          breakdown={[
            {
              label: t("pillars.access.onCriticalApps"),
              value: access.onCriticalApps,
              href: "/applications?criticality=CRITICAL",
            },
            {
              label: t("pillars.access.expiring", {
                days: access.expiringWithinDays,
              }),
              value: access.expiringSoon,
              href: "/applications",
            },
          ]}
        />
        <PillarCard
          pillar="knowledge"
          index={2}
          icon={BookOpenIcon}
          title={t("pillars.knowledge.title")}
          metric={articles.total}
          metricLabel={t("pillars.knowledge.metricLabel", {
            count: articles.total,
          })}
          href="/kb"
          cta={t("pillars.knowledge.cta")}
          breakdown={[
            {
              label: t("pillars.knowledge.published"),
              value: articles.published,
              href: "/kb?status=PUBLISHED",
            },
            {
              label: t("pillars.knowledge.drafts"),
              value: articles.draft,
              href: "/kb?status=DRAFT",
            },
          ]}
        />
        <PillarCard
          pillar="inventory"
          index={3}
          icon={CubeIcon}
          title={t("pillars.consumables.title")}
          metric={consumables.total}
          metricLabel={t("pillars.consumables.metricLabel", {
            count: consumables.total,
          })}
          href="/consumables"
          cta={t("pillars.consumables.cta")}
          breakdown={[
            {
              label: t("pillars.consumables.lowOnStock"),
              value: consumables.lowStock,
              href: "/consumables?lowStock=true",
            },
          ]}
        />
      </section>

      {canSeeActivityFeed ? (
        // ADMIN command surface: the feed takes the wider 3/5 column, the sticky Pulse rail the
        // narrower 2/5. Below `lg` the grid collapses to one column and the rail reflows under
        // the feed (an acceptance criterion). `items-start` lets the rail's `lg:sticky` travel
        // instead of being stretched to the feed's height.
        <div className="grid gap-6 lg:grid-cols-5 lg:items-start">
          <div className="lg:col-span-3">
            <RecentActivityPanel />
          </div>
          <div className="lg:col-span-2">
            <PulseRail summary={summary} quickActions={quickActions} />
          </div>
        </div>
      ) : (
        // non-admin command surface (no `logs:read`): the sensitive activity feed is hidden, so
        // the same three Pulse widgets reflow into a full-width horizontal band instead of a lone
        // narrow column — a deliberate, balanced close to the page.
        <PulseRail
          summary={summary}
          quickActions={quickActions}
          layout="grid"
        />
      )}
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
  extra,
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
  /** Optional viz rendered between the breakdown and the footer (e.g. the asset-health bar). */
  extra?: ReactNode;
  footer?: { label: string; href: string };
  href: string;
  cta: string;
}) {
  const t = useTranslations("dashboard");
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
            <p className="text-muted-foreground">{t("noDataYet")}</p>
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
        {extra}
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

/**
 * A slim, deep-linked operational-health bar for the Assets card — three proportional segments of
 * `assets.byStatus`, so the headline count gains a glanceable "how healthy is the estate?" read
 * without any new backend (the summary already zero-fills every status).
 *
 * Buckets: Operational → `--success`; In maintenance + In storage → `--warning` (at rest, not yet
 * out of service); Lost + Retired + Unknown → `--muted-foreground` (out of service / unaccounted).
 *
 * Only the single-status Operational segment deep-links (to `?status=OPERATIONAL`). The other two
 * are COMPOSITE buckets (two/three statuses each), and the assets list only filters by ONE status —
 * a deep-link would always under-deliver versus the legend count, so those rows stay non-interactive
 * (count shown, no link) rather than lie about where they go.
 *
 * AA / a11y: the segments are SOLID semantic-token fills used decoratively (no text sits on them),
 * so there is no text-contrast concern — `--success`/`--warning`/`--muted-foreground` are the
 * AA-paired status tokens and carry dark-mode parity. Meaning is never colour-alone: a visible
 * legend below names each bucket with its tabular count, and the bar carries an `aria-label`
 * summarising the split for screen readers. Plain divs + a flex track, no chart lib.
 */
function AssetHealthBar({
  byStatus,
  total,
}: {
  byStatus: Record<AssetStatus, number>;
  total: number;
}) {
  const t = useTranslations("dashboard");
  const operational = byStatus.OPERATIONAL ?? 0;
  const transitional = (byStatus.IN_MAINTENANCE ?? 0) + (byStatus.IN_STORAGE ?? 0);
  const inactive =
    (byStatus.LOST ?? 0) + (byStatus.RETIRED ?? 0) + (byStatus.UNKNOWN ?? 0);

  // Nothing to show until there's at least one asset — the card already reads "0 assets".
  if (total === 0) return null;

  const segments: {
    key: string;
    label: string;
    value: number;
    bar: string;
    dot: string;
    /** Single-status segments deep-link; composite buckets (no single `?status=`) omit it. */
    href?: string;
  }[] = [
    {
      key: "operational",
      label: t("healthBar.operational"),
      value: operational,
      bar: "bg-success",
      dot: "bg-success",
      href: "/assets?status=OPERATIONAL",
    },
    {
      key: "transitional",
      label: t("healthBar.transitional"),
      value: transitional,
      bar: "bg-warning",
      dot: "bg-warning",
    },
    {
      key: "inactive",
      label: t("healthBar.inactive"),
      value: inactive,
      bar: "bg-muted-foreground",
      dot: "bg-muted-foreground",
    },
  ].filter((segment) => segment.value > 0);

  return (
    <div className="space-y-1.5">
      <div
        className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={t("healthBar.ariaLabel", {
          operational,
          transitional,
          inactive,
          total,
        })}
      >
        {segments.map((segment) =>
          // The bar is decorative (the legend carries the meaning); only the deep-linkable
          // Operational segment is a real link, the composite buckets are plain fills.
          segment.href ? (
            <Link
              key={segment.key}
              href={segment.href}
              tabIndex={-1}
              aria-hidden
              className={cn("h-full outline-none", segment.bar)}
              style={{ width: `${(segment.value / total) * 100}%` }}
            />
          ) : (
            <span
              key={segment.key}
              aria-hidden
              className={cn("h-full", segment.bar)}
              style={{ width: `${(segment.value / total) * 100}%` }}
            />
          ),
        )}
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {segments.map((segment) => {
          const content = (
            <>
              <span
                className={cn("size-2 rounded-full", segment.dot)}
                aria-hidden
              />
              <span>{segment.label}</span>
              <span className="font-medium tabular-nums text-foreground">
                {segment.value}
              </span>
            </>
          );
          return (
            <li key={segment.key}>
              {segment.href ? (
                <Link
                  href={segment.href}
                  className="-mx-1 inline-flex items-center gap-1.5 rounded px-1 py-0.5 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {content}
                </Link>
              ) : (
                // Composite bucket: no honest single-status destination, so show the count
                // without a link rather than under-deliver on a click.
                <span className="-mx-1 inline-flex items-center gap-1.5 px-1 py-0.5">
                  {content}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
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
 * The operationally noteworthy subset of the summary, as the deep-linked rows the "Needs
 * attention" zone renders: in-maintenance and lost assets, low-stock consumables, soon-to-expire
 * grants and grants on critical apps. Zero-count items are dropped, so an empty array means
 * "nothing needs attention". Pulled out as a pure builder so both the zone and the Pulse rail's
 * all-clear/quick-actions tile derive their attention count from ONE source (no drift).
 */
function buildAttentionItems(
  summary: DashboardSummary,
  t: ReturnType<typeof useTranslations<"dashboard">>,
): AttentionItem[] {
  const { assets, access, consumables } = summary;
  const inMaintenance = assets.byStatus.IN_MAINTENANCE ?? 0;
  const lost = assets.byStatus.LOST ?? 0;

  return (
    [
      {
        key: "expiring-grants",
        icon: KeyIcon,
        label: t("needsAttention.expiringGrants", {
          count: access.expiringSoon,
          days: access.expiringWithinDays,
        }),
        count: access.expiringSoon,
        tone: "warning",
        href: "/applications",
      },
      {
        key: "critical-grants",
        icon: KeyIcon,
        label: t("needsAttention.criticalGrants", {
          count: access.onCriticalApps,
        }),
        count: access.onCriticalApps,
        tone: "warning",
        href: "/applications?criticality=CRITICAL",
      },
      {
        key: "low-stock",
        icon: CubeIcon,
        label: t("needsAttention.lowStock", { count: consumables.lowStock }),
        count: consumables.lowStock,
        tone: "warning",
        href: "/consumables?lowStock=true",
      },
      {
        key: "in-maintenance",
        icon: WrenchScrewdriverIcon,
        label: t("needsAttention.inMaintenance", { count: inMaintenance }),
        count: inMaintenance,
        tone: "warning",
        href: "/assets?status=IN_MAINTENANCE",
      },
      {
        key: "lost",
        icon: ExclamationTriangleIcon,
        label: t("needsAttention.lost", { count: lost }),
        count: lost,
        tone: "danger",
        href: "/assets?status=LOST",
      },
    ] satisfies AttentionItem[]
  ).filter((item) => item.count > 0);
}

/**
 * "Needs attention" zone — the operationally noteworthy subset of the summary, rendered as
 * deep-linked rows. Each row links into the PRE-FILTERED list it describes (same URL filter
 * params the lists read); if nothing needs attention, an all-clear note is shown instead.
 */
function NeedsAttention({ summary }: { summary: DashboardSummary }) {
  const t = useTranslations("dashboard");
  const items = buildAttentionItems(summary, t);

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold tracking-tight">
        {t("needsAttention.heading")}
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
              {t("needsAttention.allClear")}
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
const SKELETON_FEED_KEYS = ["a", "b", "c", "d"] as const;
const SKELETON_RAIL_KEYS = ["a", "b", "c"] as const;

/**
 * Loading placeholder mirroring the loaded layout (Wave 3a): the needs-attention zone, the four
 * pillar cards, then the command surface — so the page doesn't reflow when data lands. The command
 * surface tracks the same `logs:read` gate as the loaded view (issue #179): admins get the
 * two-column feed + Pulse-rail shimmer; non-admins get the three-up horizontal band (no feed
 * placeholder, so the skeleton never promises a feed they won't get). The `animate-shimmer` sweep
 * is composed over each Skeleton's muted fill at the call site (the vendored Skeleton primitive
 * stays untouched); reduced-motion stills the sweep globally.
 */
function DashboardSkeleton({
  canSeeActivityFeed,
}: {
  canSeeActivityFeed: boolean;
}) {
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
      {canSeeActivityFeed ? (
        <div className="grid gap-6 lg:grid-cols-5 lg:items-start">
          <div className="lg:col-span-3">
            <Skeleton className="mb-3 h-6 w-32 animate-shimmer" />
            <Card>
              <CardContent className="space-y-4 pt-6">
                {SKELETON_FEED_KEYS.map((key) => (
                  <div key={key} className="flex gap-3">
                    <Skeleton className="size-8 shrink-0 rounded-lg animate-shimmer" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-2/3 animate-shimmer" />
                      <Skeleton className="h-3 w-1/4 animate-shimmer" />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
          <div className="flex flex-col gap-4 lg:col-span-2">
            {SKELETON_RAIL_KEYS.map((key) => (
              <Card key={key}>
                <CardContent className="space-y-3 pt-6">
                  <Skeleton className="h-5 w-28 animate-shimmer" />
                  <Skeleton className="h-4 w-full animate-shimmer" />
                  <Skeleton className="h-4 w-3/4 animate-shimmer" />
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ) : (
        // non-admin: mirror the three-up horizontal band (no feed placeholder).
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {SKELETON_RAIL_KEYS.map((key) => (
            <Card key={key} className="h-full">
              <CardContent className="space-y-3 pt-6">
                <Skeleton className="h-5 w-28 animate-shimmer" />
                <Skeleton className="h-4 w-full animate-shimmer" />
                <Skeleton className="h-4 w-3/4 animate-shimmer" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
