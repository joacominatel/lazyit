import { cn } from "@/lib/utils";

export type StockTone = "ok" | "low" | "out";

/** Stock status: out at 0, low at/below the reorder threshold, ok otherwise (ADR-0034). */
export function stockTone(currentStock: number, minStock: number | null): StockTone {
  if (currentStock <= 0) return "out";
  if (minStock != null && currentStock <= minStock) return "low";
  return "ok";
}

const TONE_CLASS: Record<StockTone, string> = {
  ok: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  low: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  out: "bg-destructive/10 text-destructive",
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
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-sm font-medium tabular-nums",
        TONE_CLASS[tone],
        className,
      )}
    >
      {currentStock}
      {unit ? ` ${unit}` : ""}
    </span>
  );
}
