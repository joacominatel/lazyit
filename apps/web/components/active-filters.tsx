"use client";

import { XMarkIcon } from "@heroicons/react/16/solid";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One active filter, rendered as a dismissible chip. `label` is the human-readable summary (e.g.
 * `Status: Lost`, `Search: "macbook"`); `onClear` removes just this filter (resetting it to its
 * default via `useListParams().setFilter(name, default)` / `setQ("")`).
 */
export interface ActiveFilterChip {
  /** Stable key for the list (usually the filter's URL param name). */
  key: string;
  /** Human-readable chip text. */
  label: ReactNode;
  /** Remove this one filter. */
  onClear: () => void;
}

/**
 * The active-filter summary bar shown above a list when any filter or search is set. Each active
 * filter is a dismissible chip; a trailing "Clear all" resets everything (wired to
 * `useListParams().clearFilters`). Renders nothing when there are no active filters, so a page can
 * mount it unconditionally. Drives the same `filtersActive` signal the URL list-state hook exposes.
 */
export function ActiveFilters({
  chips,
  onClearAll,
  className,
}: {
  chips: ActiveFilterChip[];
  onClearAll: () => void;
  className?: string;
}) {
  if (chips.length === 0) return null;
  return (
    <div
      className={cn("flex flex-wrap items-center gap-2", className)}
      aria-label="Active filters"
    >
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-1 rounded-full border bg-muted/50 py-0.5 pr-1 pl-2.5 text-xs font-medium"
        >
          {chip.label}
          <button
            type="button"
            onClick={chip.onClear}
            aria-label={
              typeof chip.label === "string"
                ? `Clear filter: ${chip.label}`
                : "Clear filter"
            }
            className="flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XMarkIcon className="size-3.5" />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className="rounded text-xs font-medium text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        Clear all
      </button>
    </div>
  );
}

/**
 * The inline "Clear filters" recovery link for a list's filtered-empty row (pass to
 * `ResourceTable.filteredEmptyAction`). Wire `onClick` to `useListParams().clearFilters`.
 */
export function ClearFiltersLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded text-sm font-medium text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      Clear filters
    </button>
  );
}
