import { cn } from "@/lib/utils";

const LABELS = ["Welcome", "Configure", "Administrator", "Done"];

/**
 * Compact step indicator for the setup wizard — a row of numbered pips with the brand indigo for the
 * current/completed steps. Responsive: labels collapse on narrow screens, the pips always show.
 */
export function WizardSteps({
  current,
  total,
}: {
  current: number;
  total: number;
}) {
  return (
    <ol className="mt-3 flex items-center gap-1.5" aria-label="Setup progress">
      {Array.from({ length: total }, (_, i) => i + 1).map((n) => {
        const done = n < current;
        const active = n === current;
        return (
          <li key={n} className="flex flex-1 items-center gap-1.5">
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium transition-colors",
                active && "border-primary bg-primary text-primary-foreground",
                done && "border-primary/40 bg-primary/10 text-primary",
                !active && !done && "border-border text-muted-foreground",
              )}
              aria-current={active ? "step" : undefined}
            >
              {n}
            </span>
            <span
              className={cn(
                "hidden truncate text-xs sm:inline",
                active ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {LABELS[n - 1]}
            </span>
            {n < total && (
              <span
                className={cn(
                  "hidden h-px flex-1 sm:block",
                  done ? "bg-primary/40" : "bg-border",
                )}
                aria-hidden
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
