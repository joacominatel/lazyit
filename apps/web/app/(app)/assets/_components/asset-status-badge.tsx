import type { AssetStatus } from "@lazyit/shared";
import { Badge } from "@/components/ui/badge";
import { StatusDot, type StatusTone } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";

/** Label + status tone + badge variant per asset lifecycle status. The dot color comes
 *  from the shared status tones (single source of truth), not a hardcoded palette. */
const STATUS: Record<
  AssetStatus,
  { label: string; tone: StatusTone; variant: "secondary" | "outline" }
> = {
  OPERATIONAL: { label: "Operational", tone: "success", variant: "secondary" },
  IN_MAINTENANCE: { label: "In maintenance", tone: "warning", variant: "secondary" },
  IN_STORAGE: { label: "In storage", tone: "info", variant: "secondary" },
  RETIRED: { label: "Retired", tone: "neutral", variant: "outline" },
  LOST: { label: "Lost", tone: "danger", variant: "outline" },
  UNKNOWN: { label: "Unknown", tone: "neutral", variant: "outline" },
};

/** Human-readable label for an asset status (also used by the status select). */
export function formatAssetStatus(status: AssetStatus): string {
  return STATUS[status].label;
}

export function AssetStatusBadge({
  status,
  className,
}: {
  status: AssetStatus;
  className?: string;
}) {
  const meta = STATUS[status];
  return (
    <Badge variant={meta.variant} className={cn("gap-1.5", className)}>
      <StatusDot tone={meta.tone} />
      {meta.label}
    </Badge>
  );
}
