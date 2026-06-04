"use client";

import type { AssetStatus } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { StatusDot, type StatusTone } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";

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
 * English fallback label for an asset status, keyed by the enum value. Prefer
 * {@link useAssetStatusLabel} (locale-aware) in React render; this synchronous helper
 * survives for non-React / cross-area callers (e.g. the dashboard) that the i18n
 * migration hasn't reached yet — they read English until rewired by their own area pass.
 */
const STATUS_LABEL_EN: Record<AssetStatus, string> = {
  OPERATIONAL: "Operational",
  IN_MAINTENANCE: "In maintenance",
  IN_STORAGE: "In storage",
  RETIRED: "Retired",
  LOST: "Lost",
  UNKNOWN: "Unknown",
};

export function formatAssetStatus(status: AssetStatus): string {
  return STATUS_LABEL_EN[status];
}

export function AssetStatusBadge({
  status,
  className,
}: {
  status: AssetStatus;
  className?: string;
}) {
  const t = useTranslations("assets.status");
  const meta = STATUS[status];
  return (
    <Badge variant={meta.variant} className={cn("gap-1.5", className)}>
      <StatusDot tone={meta.tone} />
      {t(status)}
    </Badge>
  );
}
