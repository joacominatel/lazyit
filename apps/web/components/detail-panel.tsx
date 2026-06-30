import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * DetailPanel — the single token-driven section primitive for the read-only detail pages
 * (`{assets,applications,consumables,users,locations}/[id]` + `kb/[slug]`). It replaces the
 * copy-pasted per-page `Panel` helper that each detail page used to redeclare.
 *
 * It is built on the Card tokens (`bg-card` / `rounded-xl` / `ring-1 ring-foreground/10`), not a
 * raw `border`, so it inherits automatic dark-mode parity and stays visually consistent with the
 * rest of the surface system (`components/ui/card.tsx`). A header row renders the title and an
 * optional trailing `actions` slot; the body is the children.
 */
export function DetailPanel({
  title,
  actions,
  className,
  children,
}: {
  /** Section heading. */
  title: ReactNode;
  /** Optional trailing action(s) in the header row (e.g. an "Assign user" button). */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "rounded-xl bg-card p-5 text-card-foreground ring-1 ring-foreground/10",
        className,
      )}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/**
 * DetailField — a single label/value pair, the building block of the details grids inside a
 * {@link DetailPanel}. Renders a muted label over the value. Compose several inside a `<dl>` grid
 * (the pages keep their own `grid` wrapper so each can choose its column count).
 */
export function DetailField({
  label,
  mono = false,
  className,
  children,
}: {
  label: ReactNode;
  /**
   * Render the value in the Ledger data face (Commit Mono) with tabular figures — for machine
   * strings and temporal/numeric columns (IDs, serials, dates, counts). Names/prose stay on the
   * body face (ADR-0077). Default off.
   */
  mono?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={cn("text-sm", mono && "font-mono tabular-nums")}>{children}</dd>
    </div>
  );
}

/**
 * DetailSkeleton — the shared loading placeholder for detail and edit pages. Renders a breadcrumb
 * bar, a title bar and one or more panel-shaped blocks, replacing the bespoke `<Skeleton>` stacks
 * each page used to hand-roll. `panels` controls how many panel blocks to show.
 */
export function DetailSkeleton({
  panels = 2,
  className,
}: {
  /** How many panel-shaped blocks to render under the title. Defaults to 2. */
  panels?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-6", className)} aria-hidden>
      <div className="space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8 w-1/2" />
      </div>
      {Array.from({ length: panels }).map((_, index) => (
        <Skeleton key={index} className="h-40 w-full rounded-xl" />
      ))}
    </div>
  );
}
