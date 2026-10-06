"use client";

import type { AssetStatus } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { StatusDot, type StatusTone } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";
import { safeLabelColor } from "./asset-status-options";

/** Status tone + badge variant per asset lifecycle status. The human-readable label comes
 *  from the `assets.status` namespace (keyed by the enum value); the dot color comes from
 *  the shared status tones (single source of truth), not a hardcoded palette. */
const STATUS: Record<
  AssetStatus,
  { tone: StatusTone; variant: "secondary" | "outline" }
> = {
  OPERATIONAL: { tone: "success", variant: "secondary" },
  IN_MAINTENANCE: { tone: "warning", variant: "secondary" },
  IN_STORAGE: { tone: "info", variant: "secondary" },
  RETIRED: { tone: "neutral", variant: "outline" },
  LOST: { tone: "danger", variant: "outline" },
  UNKNOWN: { tone: "neutral", variant: "outline" },
};

/** The status tone of a built-in asset status — the dot a custom status without a colour falls back to. */
export function assetStatusTone(status: AssetStatus): StatusTone {
  return STATUS[status].tone;
}

/**
 * Hook returning a translator for an asset status' human-readable label (keyed by the
 * enum value under `assets.status`). Use at call sites that render a status label outside
 * the badge (the status select + active-filter chips).
 */
export function useAssetStatusLabel(): (status: AssetStatus) => string {
  const t = useTranslations("assets.status");
  return (status: AssetStatus) => t(status);
}

/**
 * The colour dot of a status option or badge: a custom status's own colour when it has a valid one,
 * otherwise its built-in status's tone. Decorative (the label carries the meaning).
 */
export function AssetStatusSwatch({
  status,
  color,
  className,
}: {
  status: AssetStatus;
  color?: string | null;
  className?: string;
}) {
  const safe = safeLabelColor(color);
  if (safe) {
    return (
      <span
        aria-hidden="true"
        data-slot="status-dot"
        className={cn("size-1.5 shrink-0 rounded-full", className)}
        style={{ backgroundColor: safe }}
      />
    );
  }
  return <StatusDot tone={STATUS[status].tone} className={className} />;
}

/**
 * An asset's status. With a custom status (ADR-0101) it shows the custom name, its colour on the dot, and
 * the built-in status it maps to — as visible secondary text with `showKind` (detail header, quick view),
 * else as a tooltip plus screen-reader text so dense tables stay compact. Without one it is unchanged.
 */
export function AssetStatusBadge({
  status,
  label,
  showKind = false,
  className,
}: {
  status: AssetStatus;
  /** The asset's inline custom status, when it has one (`statusLabel` on the asset reads). */
  label?: { name: string; color: string | null } | null;
  /** Show the built-in status next to a custom name (wide surfaces). */
  showKind?: boolean;
  className?: string;
}) {
  const t = useTranslations("assets.status");
  const meta = STATUS[status];
  if (!label) {
    return (
      <Badge variant={meta.variant} className={cn("gap-1.5", className)}>
        <StatusDot tone={meta.tone} />
        {t(status)}
      </Badge>
    );
  }
  const kind = t(status);
  return (
    <Badge
      variant={meta.variant}
      className={cn("gap-1.5", className)}
      title={showKind ? undefined : kind}
    >
      <AssetStatusSwatch status={status} color={label.color} />
      {label.name}
      {showKind ? (
        <span className="text-muted-foreground">· {kind}</span>
      ) : (
        <span className="sr-only">({kind})</span>
      )}
    </Badge>
  );
}
