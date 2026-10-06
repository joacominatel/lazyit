"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, type ComponentType, type ReactNode } from "react";
import { resolveRecordTab } from "@/lib/record/record-state";
import { cn } from "@/lib/utils";

/**
 * Record-page primitives (issue #1525) — the shared frame of the asset and user detail pages: a summary
 * card (identity header + attention items + a key-facts strip) over a two-column body (tabbed main
 * content beside a properties column). The pages compose these; `PageHeader` still owns the title so
 * the type scale stays single-sourced. Surfaces ride the Card tokens like `DetailPanel` (ADR-0077).
 */

/** The summary card: the `PageHeader` row, then optional attention items, then the key-facts strip. */
export function RecordHero({
  header,
  attention,
  facts,
}: {
  header: ReactNode;
  attention?: ReactNode;
  facts?: ReactNode;
}) {
  return (
    <section className="rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10">
      <div className="p-5">{header}</div>
      {attention}
      {facts}
    </section>
  );
}

const ATTENTION_TONE = {
  danger: "bg-destructive/10 text-destructive-text",
  warning: "bg-warning/15 text-warning-text",
  neutral: "bg-muted text-muted-foreground",
} as const;

export type AttentionTone = keyof typeof ATTENTION_TONE;

/**
 * The row of "needs action" items under the header. Renders nothing when `items` is empty, so a record
 * with nothing to do keeps a calm header. The list carries an accessible name for assistive tech.
 */
export function RecordAttention({
  label,
  items,
}: {
  /** Accessible name for the list. */
  label: string;
  /** Keyed {@link AttentionItem}s. */
  items: ReactNode[];
}) {
  if (items.length === 0) return null;
  return (
    <ul aria-label={label} className="-mt-1 flex flex-wrap gap-2 px-5 pb-4">
      {items}
    </ul>
  );
}

/**
 * One attention item. The tone tints the chip; the text holds AA on its tint through the `-text`
 * tokens (ADR-0049). The icon is decorative.
 */
export function AttentionItem({
  tone,
  icon: Icon,
  children,
}: {
  tone: AttentionTone;
  icon: ComponentType<{ className?: string }>;
  children: ReactNode;
}) {
  return (
    <li
      className={cn(
        "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs",
        ATTENTION_TONE[tone],
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </li>
  );
}

/** The key-facts strip: hairline-divided cells, four across on wide screens, two on narrow ones. */
export function RecordFacts({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 border-t border-border lg:grid-cols-4 [&>*]:border-border max-lg:[&>*:nth-child(n+3)]:border-t max-lg:[&>*:nth-child(even)]:border-l lg:[&>*:not(:first-child)]:border-l">
      {children}
    </div>
  );
}

/**
 * One key fact: an uppercase label, the value, an optional muted line under it, and an optional
 * `meter` (a 0..1 fill rendered as a thin bar). With `onSelect` the cell becomes a button — the user
 * page's counters open their tab. `mono` sets the value in the data face (ADR-0077).
 */
export function RecordFact({
  label,
  value,
  sub,
  meter,
  tone,
  mono = false,
  onSelect,
  selectLabel,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  meter?: number;
  tone?: "warning" | "danger";
  mono?: boolean;
  onSelect?: () => void;
  /** Accessible name for the button form (e.g. "Open the Assets tab"). */
  selectLabel?: string;
}) {
  const body = (
    <>
      <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <span
        className={cn(
          "flex min-w-0 items-center gap-2 text-sm font-semibold",
          mono && "font-mono tabular-nums",
          tone === "warning" && "text-warning-text",
          tone === "danger" && "text-destructive-text",
        )}
      >
        {value}
      </span>
      {sub ? <span className="text-xs text-muted-foreground">{sub}</span> : null}
      {meter != null ? (
        <span aria-hidden className="mt-1 block h-1 overflow-hidden rounded-full bg-muted">
          <span
            className={cn(
              "block h-full rounded-full",
              tone === "danger" ? "bg-destructive" : tone === "warning" ? "bg-warning" : "bg-success",
            )}
            style={{ width: `${Math.round(Math.min(1, Math.max(0, meter)) * 100)}%` }}
          />
        </span>
      ) : null}
    </>
  );
  const cell = "grid min-w-0 content-start gap-1 px-5 py-3.5 text-left";
  if (onSelect) {
    return (
      <div className="min-w-0">
        <button
          type="button"
          onClick={onSelect}
          aria-label={selectLabel}
          className={cn(
            cell,
            "size-full outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          )}
        >
          {body}
        </button>
      </div>
    );
  }
  return <div className={cell}>{body}</div>;
}

/**
 * The body grid: the main column and, on wide screens, a fixed-width properties column beside it.
 *
 * The main column opens with the tab bar, so on wide screens the side column drops by exactly that
 * much — the `TabsList` (h-9) + the `Tabs` gap (gap-2) + the `TabsContent` top padding (pt-2) = 3.25rem
 * — and its first panel lines up with the first panel of the open tab (#1531). Keep the three in step if
 * any of them changes. Stacked below `xl`, the offset is dropped.
 */
export function RecordLayout({
  main,
  aside,
}: {
  main: ReactNode;
  aside: ReactNode;
}) {
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-4">{main}</div>
      <aside className="min-w-0 space-y-4 xl:pt-13">{aside}</aside>
    </div>
  );
}

/** A tab label's count chip (mono, tabular). Hidden when the count is unknown. */
export function TabCount({ value }: { value: number | undefined }) {
  if (value == null) return null;
  return (
    <span className="rounded-full bg-muted px-1.5 font-mono text-[11px] text-muted-foreground tabular-nums group-data-[state=active]/tab:bg-primary/10 group-data-[state=active]/tab:text-primary">
      {value}
    </span>
  );
}

/**
 * The record page's active tab, kept in `?tab=` so a deep link or a back navigation lands on the same
 * tab. Reads through `useSearchParams` and writes with `history.replaceState`, which the App Router
 * syncs into its hooks without a server round-trip (a `router.replace` would re-run the page's
 * server prefetch on every tab click). The default tab is written as no parameter at all, and a value
 * naming a tab this viewer cannot see resolves to the default.
 */
export function useRecordTab<T extends string>(
  tabs: readonly T[],
  fallback: T,
): [T, (next: string) => void] {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const tab = resolveRecordTab(searchParams.get("tab"), tabs, fallback);

  const setTab = useCallback(
    (next: string) => {
      const params = new URLSearchParams(window.location.search);
      if (next === fallback) params.delete("tab");
      else params.set("tab", next);
      const query = params.toString();
      window.history.replaceState(
        null,
        "",
        query ? `${pathname}?${query}` : pathname,
      );
    },
    [fallback, pathname],
  );

  return [tab, setTab];
}
