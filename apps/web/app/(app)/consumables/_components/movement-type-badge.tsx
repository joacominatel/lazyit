import type { ConsumableMovementType } from "@lazyit/shared";
import { cn } from "@/lib/utils";

const TONE: Record<ConsumableMovementType, string> = {
  IN: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  OUT: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  ADJUSTMENT: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
};

const LABEL: Record<ConsumableMovementType, string> = {
  IN: "In",
  OUT: "Out",
  ADJUSTMENT: "Adjust",
};

/** Colored chip for a stock movement direction (IN adds, OUT subtracts, ADJUSTMENT sets). */
export function MovementTypeBadge({ type }: { type: ConsumableMovementType }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-md px-1.5 py-0.5 text-xs font-medium",
        TONE[type],
      )}
    >
      {LABEL[type]}
    </span>
  );
}
