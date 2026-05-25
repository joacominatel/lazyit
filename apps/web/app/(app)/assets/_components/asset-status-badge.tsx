import type { AssetStatus } from "@lazyit/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Label + dot color + badge variant per asset lifecycle status. */
const STATUS: Record<
  AssetStatus,
  { label: string; dot: string; variant: "secondary" | "outline" }
> = {
  OPERATIONAL: { label: "Operational", dot: "bg-emerald-500", variant: "secondary" },
  IN_MAINTENANCE: { label: "In maintenance", dot: "bg-amber-500", variant: "secondary" },
  IN_STORAGE: { label: "In storage", dot: "bg-sky-500", variant: "secondary" },
  RETIRED: { label: "Retired", dot: "bg-muted-foreground/40", variant: "outline" },
  LOST: { label: "Lost", dot: "bg-rose-500", variant: "outline" },
  UNKNOWN: { label: "Unknown", dot: "bg-muted-foreground/40", variant: "outline" },
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
      <span className={cn("size-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </Badge>
  );
}
