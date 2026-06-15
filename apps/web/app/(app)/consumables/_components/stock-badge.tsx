import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";

export type StockTone = "ok" | "low" | "out";

/** Stock status: out at 0, low at/below the reorder threshold, ok otherwise (ADR-0034). */
export function stockTone(currentStock: number, minStock: number | null): StockTone {
  if (currentStock <= 0) return "out";
  if (minStock != null && currentStock <= minStock) return "low";
  return "ok";
}

/** Stock status → the shared status tone (single source of truth for stock-status color). */
export const STOCK_STATUS_TONE: Record<StockTone, StatusTone> = {
  ok: "success",
  low: "warning",
  out: "danger",
};

/** The on-hand quantity rendered with a status color (green / amber / red). */
export function StockBadge({
  currentStock,
  minStock,
  unit,
  className,
}: {
  currentStock: number;
  minStock: number | null;
  unit?: string;
  className?: string;
}) {
  const tone = stockTone(currentStock, minStock);
  return (
    <StatusBadge
      tone={STOCK_STATUS_TONE[tone]}
      className={cn("h-auto rounded-md px-2 text-sm tabular-nums", className)}
    >
      {currentStock}
      {unit ? ` ${unit}` : ""}
    </StatusBadge>
  );
}
