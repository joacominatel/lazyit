"use client";

import {
  ArrowRightIcon,
  CheckCircleIcon,
  ClockIcon,
  PlusIcon,
  ShieldExclamationIcon,
} from "@heroicons/react/24/outline";
import type { AssetStatus, DashboardSummary } from "@lazyit/shared";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatAssetStatus } from "../../assets/_components/asset-status-badge";

/**
 * PulseRail — the dashboard's sticky right-hand "Pulse" column (Wave 3a, ADR-0049
 * «Activated Restraint»). A compact trio that turns the existing `GET /dashboard/summary`
 * snapshot into an at-a-glance read of the estate, with zero new backend and zero new deps:
 *
 *   A. Assets-by-status DONUT — a pure CSS `conic-gradient` (no chart lib) over
 *      `assets.byStatus`, the total centred, and a deep-linked legend.
 *   B. Access-health mini-panel — `expiringSoon` + `onCriticalApps`, counts always shown
 *      (0 ⇒ "All current"), each row deep-linking into the pre-filtered list.
 *   C. All-clear / Quick-actions tile — a cheerful all-clear when nothing needs attention,
 *      else the relocated cross-pillar quick actions (each gated on its permission).
 *
 * Colour discipline (ADR-0049): a status hue only ever appears as a donut SEGMENT or a
 * legend DOT — every readable number/label sits on `--foreground` / `--card-foreground`.
 * No pillar/chart/status hue is used as readable text.
 */
export function PulseRail({
  summary,
  attentionCount,
  quickActions,
}: {
  summary: DashboardSummary;
  /** How many "Needs attention" items are live — drives the all-clear vs quick-actions tile. */
  attentionCount: number;
  /** The cross-pillar quick actions the caller is permitted to see (already permission-gated). */
  quickActions: QuickAction[];
}) {
  return (
    // `self-start` keeps the rail from stretching to the feed's height (so `sticky` has room
    // to travel); `lg:sticky lg:top-6` pins it once the two-column layout engages. Below `lg`
    // it is a normal block that reflows under the feed. The (app) route template animates with
    // OPACITY ONLY (no transform), so no ancestor traps this sticky.
    <div className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
      <AssetStatusDonut byStatus={summary.assets.byStatus} total={summary.assets.total} />
      <AccessHealthPanel access={summary.access} />
      <PulseActionTile attentionCount={attentionCount} quickActions={quickActions} />
    </div>
  );
}

/* ───────────────────────────── Widget A — Assets-by-status donut ───────────────────────────── */

/**
 * Status → semantic/categorical token for the donut + legend. Aligned with the
 * AssetStatusBadge tones so a status reads the same colour here as in any list:
 * OPERATIONAL=success, IN_MAINTENANCE=warning, IN_STORAGE=info, LOST=destructive, and
 * RETIRED/UNKNOWN fall to the muted neutral (out-of-service, no alarm hue). `fill` is the
 * raw CSS var for the inline `conic-gradient`; `dot` is the scanner-safe legend dot utility.
 */
const STATUS_SEGMENT: Record<AssetStatus, { fill: string; dot: string }> = {
  OPERATIONAL: { fill: "var(--success)", dot: "bg-success" },
  IN_MAINTENANCE: { fill: "var(--warning)", dot: "bg-warning" },
  IN_STORAGE: { fill: "var(--info)", dot: "bg-info" },
  RETIRED: { fill: "var(--muted-foreground)", dot: "bg-muted-foreground" },
  LOST: { fill: "var(--destructive)", dot: "bg-destructive" },
  UNKNOWN: { fill: "var(--muted-foreground)", dot: "bg-muted-foreground" },
};

/** Lifecycle order so the donut arcs + legend render stably regardless of object key order. */
const DONUT_STATUS_ORDER: AssetStatus[] = [
  "OPERATIONAL",
  "IN_MAINTENANCE",
  "IN_STORAGE",
  "RETIRED",
  "LOST",
  "UNKNOWN",
];

/**
 * The star moment: an assets-by-status donut drawn with a single CSS `conic-gradient` — no
 * chart library, no canvas, no SVG arcs. Each present status contributes a proportional wedge
 * (hard colour stops, so the slices read as discrete segments, not a blend); a centred
 * `--card` disc punches the ring into a donut with the total in tabular mono at its core.
 *
 * AA / a11y: the gradient is purely decorative (`role="img"` + a summarising `aria-label`);
 * every readable value lives in the legend on `--foreground`, with the status hue carried only
 * by a dot. Each legend row deep-links to `/assets?status=X` (single-status, so the link never
 * under-delivers versus its count).
 */
function AssetStatusDonut({
  byStatus,
  total,
}: {
  byStatus: Record<AssetStatus, number>;
  total: number;
}) {
  const segments = DONUT_STATUS_ORDER.map((status) => ({
    status,
    value: byStatus[status] ?? 0,
    ...STATUS_SEGMENT[status],
  })).filter((segment) => segment.value > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Assets by status</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-5">
        {total === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            No assets yet — add your first and the breakdown shows up here.
          </p>
        ) : (
          <>
            <DonutRing segments={segments} total={total} />
            <ul className="w-full space-y-0.5 text-sm">
              {segments.map((segment) => (
                <li key={segment.status}>
                  <Link
                    href={`/assets?status=${segment.status}`}
                    className="-mx-1.5 flex items-center gap-2 rounded px-1.5 py-1 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span
                      className={cn("size-2.5 shrink-0 rounded-full", segment.dot)}
                      aria-hidden
                    />
                    <span className="flex-1 text-muted-foreground">
                      {formatAssetStatus(segment.status)}
                    </span>
                    <span className="font-medium tabular-nums text-foreground">
                      {segment.value}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The donut visual itself — a conic-gradient ring with a centred card disc and the total.
 * Built entirely from inline `style` (the gradient stops are data-derived, so they can't be
 * static Tailwind classes) over `var(--*)` tokens, so it inherits light/dark parity for free.
 * Hard stops (each colour repeated at the segment's start and end angle) keep the wedges
 * crisp rather than blending into one another.
 */
function DonutRing({
  segments,
  total,
}: {
  segments: { status: AssetStatus; value: number; fill: string; dot: string }[];
  total: number;
}) {
  // Build the conic-gradient stops purely (no running-mutable cursor — React Compiler bans
  // reassignment after render): each segment's start angle is the proportional sum of all
  // preceding segment values, its end angle that plus its own. Hard stops keep wedges crisp.
  const stops = segments
    .map((segment, i) => {
      const precedingValue = segments
        .slice(0, i)
        .reduce((sum, s) => sum + s.value, 0);
      const start = (precedingValue / total) * 360;
      const end = ((precedingValue + segment.value) / total) * 360;
      return `${segment.fill} ${start}deg ${end}deg`;
    })
    .join(", ");

  const ariaLabel = `Assets by status: ${segments
    .map((segment) => `${segment.value} ${formatAssetStatus(segment.status).toLowerCase()}`)
    .join(", ")}, ${total} total.`;

  return (
    <div
      className="relative grid size-40 place-items-center rounded-full"
      style={{ background: `conic-gradient(${stops})` }}
      role="img"
      aria-label={ariaLabel}
    >
      {/* Inner disc punches the ring into a donut and carries the total. */}
      <div className="flex size-[6.5rem] flex-col items-center justify-center rounded-full bg-card text-center shadow-e1">
        <span className="text-2xl font-semibold tabular-nums leading-none text-foreground">
          {total}
        </span>
        <span className="mt-1 text-xs text-muted-foreground">
          {total === 1 ? "asset" : "assets"}
        </span>
      </div>
    </div>
  );
}

/* ───────────────────────────── Widget B — Access-health mini-panel ───────────────────────────── */

/**
 * The honest access-health read: the two access signals the summary actually carries —
 * grants expiring within the look-ahead window, and active grants on critical apps. Both
 * counts are ALWAYS shown (a 0 reads "All current" / "None on critical apps", never hidden),
 * so the panel tells the truth about a calm estate instead of vanishing. There is no
 * per-grant timeline in the contract, so we don't fake one — that remains honest debt.
 *
 * Colour: the leading icon-chip tint cues the row's nature (warning for expiry, info for
 * critical) but every number/label is on `--foreground`/`--card-foreground`.
 */
function AccessHealthPanel({
  access,
}: {
  access: DashboardSummary["access"];
}) {
  const rows: AccessRow[] = [
    {
      key: "expiring",
      icon: ClockIcon,
      tint: "bg-warning/15 text-warning",
      label: `Expiring ≤ ${access.expiringWithinDays}d`,
      count: access.expiringSoon,
      empty: "All current",
      href: "/applications",
    },
    {
      key: "critical",
      icon: ShieldExclamationIcon,
      tint: "bg-info/15 text-info",
      label: "On critical apps",
      count: access.onCriticalApps,
      empty: "None on critical apps",
      href: "/applications?criticality=CRITICAL",
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Access health</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {rows.map((row) => (
          <AccessHealthRow key={row.key} row={row} />
        ))}
      </CardContent>
    </Card>
  );
}

interface AccessRow {
  key: string;
  icon: typeof ClockIcon;
  /** Tinted icon-chip classes — a soft hue cue, never carrying readable text. */
  tint: string;
  label: string;
  count: number;
  /** Reassuring copy shown beside the count when it is zero. */
  empty: string;
  href: string;
}

/** One access-health line: tinted icon chip + label, a tabular count, and a deep link. */
function AccessHealthRow({ row }: { row: AccessRow }) {
  const { icon: Icon, tint, label, count, empty, href } = row;
  const clear = count === 0;
  return (
    <Link
      href={href}
      className="-mx-1.5 flex items-center gap-3 rounded-md px-1.5 py-1.5 outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg",
          tint,
        )}
        aria-hidden
      >
        <Icon className="size-4" />
      </span>
      <span className="flex-1 text-sm text-foreground">{label}</span>
      {clear ? (
        <span className="text-xs text-muted-foreground">{empty}</span>
      ) : (
        <span className="text-base font-semibold tabular-nums text-foreground">
          {count}
        </span>
      )}
      <ArrowRightIcon className="size-4 text-muted-foreground" aria-hidden />
    </Link>
  );
}

/* ───────────────────────────── Widget C — All-clear / Quick-actions tile ───────────────────────────── */

export interface QuickAction {
  href: string;
  label: string;
}

/**
 * The closing tile: a single surface that flips on whether the estate needs attention.
 *
 * - Nothing needs attention ⇒ a warm ALL-CLEAR moment (a success-tinted check, a short
 *   reassurance). Delight saved for the moment it's earned, never sprayed.
 * - Something needs attention ⇒ the relocated cross-pillar QUICK ACTIONS (already
 *   permission-gated by the caller). If the caller has no actions AND there's attention, the
 *   tile renders nothing rather than an empty shell.
 */
function PulseActionTile({
  attentionCount,
  quickActions,
}: {
  attentionCount: number;
  quickActions: QuickAction[];
}) {
  if (attentionCount === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-7 text-center">
          <span
            className="flex size-12 items-center justify-center rounded-full bg-success/10 text-success"
            aria-hidden
          >
            <CheckCircleIcon className="size-7" />
          </span>
          <p className="text-sm font-medium text-foreground">All clear</p>
          <p className="max-w-[15rem] text-sm text-muted-foreground">
            Nothing needs your attention right now — the estate is in good shape.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (quickActions.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Quick actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {quickActions.map((action) => (
          <QuickActionRow key={action.href} action={action} />
        ))}
      </CardContent>
    </Card>
  );
}

/** One quick-action line — a quiet full-width jump into a create flow. */
function QuickActionRow({ action }: { action: QuickAction }) {
  return (
    <Link
      href={action.href}
      className="-mx-1.5 flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-sm text-foreground outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
        aria-hidden
      >
        <PlusIcon className="size-4" />
      </span>
      <span className="flex-1 font-medium">{action.label}</span>
      <ArrowRightIcon className="size-4 text-muted-foreground" aria-hidden />
    </Link>
  );
}
