"use client";

import {
  BoltIcon,
  GlobeAltIcon,
  HandRaisedIcon,
} from "@heroicons/react/24/outline";
import type { WorkflowConnectionKind } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import type { ComponentType, ReactNode } from "react";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";

/**
 * The lightweight bespoke DAG renderer primitives (frontend.md §3a / §12) — the SAME visual grammar as
 * `asset-history-timeline.tsx` (a vertical connector line, a status dot, AA-safe `StatusBadge` tones),
 * shared by the BUILDER diagram (the authored graph) and the RUN timeline (the traversed graph). NO
 * React Flow / xyflow: the topology is constrained (mostly linear, bounded fan-out) and authored by
 * controls, not by drawing edges — a node-graph runtime would buy us nothing and cost the design system.
 */

/** The step kinds that carry an icon + a category label. */
const STEP_KIND_ICON: Record<
  "REST" | "WEBHOOK_OUT" | "MANUAL",
  ComponentType<{ className?: string }>
> = {
  REST: GlobeAltIcon,
  WEBHOOK_OUT: BoltIcon,
  MANUAL: HandRaisedIcon,
};

/** A small chart-hue dot per kind (decorative — the label text stays on `--secondary-foreground`). */
const STEP_KIND_DOT: Record<"REST" | "WEBHOOK_OUT" | "MANUAL", string> = {
  REST: "bg-chart-1",
  WEBHOOK_OUT: "bg-chart-2",
  MANUAL: "bg-chart-4",
};

/**
 * A neutral category pill for a step kind (REST → "API / HTTP", WEBHOOK_OUT → "Webhook", MANUAL →
 * "Human task"). Neutral surface + a chart-hue dot so the label keeps AA contrast in both themes
 * (the asset-timeline categorical-badge recipe, ADR-0049 §4).
 */
export function StepKindBadge({ kind }: { kind: WorkflowConnectionKind }) {
  const t = useTranslations("workflow");
  // Only the three v1 kinds render a real badge; reserved kinds fall back to a neutral label.
  const isV1 = kind === "REST" || kind === "WEBHOOK_OUT" || kind === "MANUAL";
  const Icon = isV1 ? STEP_KIND_ICON[kind] : undefined;
  const dot = isV1 ? STEP_KIND_DOT[kind] : "bg-muted-foreground/40";
  return (
    <span className="inline-flex h-5 w-fit shrink-0 items-center gap-1.5 rounded-md bg-secondary px-2 py-0.5 text-xs font-medium whitespace-nowrap text-secondary-foreground">
      {Icon ? (
        <Icon className="size-3" aria-hidden />
      ) : (
        <span className={cn("size-1.5 shrink-0 rounded-full", dot)} aria-hidden />
      )}
      {t(`kind.${kind}`)}
    </span>
  );
}

/**
 * A connected box in the vertical spine (the timeline grammar). When `onClick` is set the whole box is
 * a button (the builder); otherwise it is a static row (the run timeline). `dotTone` colours the status
 * dot; `selected`/`invalid` decorate the builder's editing/validation state.
 */
export function WorkflowNode({
  dotTone = "neutral",
  badge,
  title,
  summary,
  meta,
  children,
  isLast = false,
  onClick,
  selected = false,
  invalid = false,
  ariaLabel,
  actions,
}: {
  dotTone?: StatusTone;
  /** A leading badge — typically the {@link StepKindBadge}. */
  badge?: ReactNode;
  title: ReactNode;
  /** A one-line summary under the title (target, success criteria, …). */
  summary?: ReactNode;
  /** Trailing metadata pinned to the right of the title row (duration, timestamp, status pill). */
  meta?: ReactNode;
  /** Expandable / extra body below the summary. */
  children?: ReactNode;
  isLast?: boolean;
  /** Makes the box a clickable button (the builder). */
  onClick?: () => void;
  selected?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
  /** Trailing controls rendered OUTSIDE the clickable area (reorder/delete in the builder). */
  actions?: ReactNode;
}) {
  const dotClass = DOT_TONE_RING[dotTone];
  const body = (
    <div
      className={cn(
        "min-w-0 flex-1 rounded-lg border p-3 transition-colors",
        onClick && "text-left hover:bg-muted/40",
        selected && "border-primary ring-1 ring-primary",
        invalid && "border-destructive ring-1 ring-destructive",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {badge}
        <span className="min-w-0 font-medium break-words">{title}</span>
        {meta ? <span className="ml-auto shrink-0">{meta}</span> : null}
      </div>
      {summary ? (
        <p className="mt-1 text-sm break-words text-muted-foreground">{summary}</p>
      ) : null}
      {children}
    </div>
  );
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {!isLast && (
        <span
          className="absolute top-4 left-[5px] h-full w-px bg-border"
          aria-hidden
        />
      )}
      <span
        className={cn(
          "mt-3.5 size-2.5 shrink-0 rounded-full ring-2 ring-background",
          dotClass,
        )}
        aria-hidden
      />
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          aria-label={ariaLabel}
          className="flex min-w-0 flex-1 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {body}
        </button>
      ) : (
        body
      )}
      {actions ? (
        <div className="flex shrink-0 flex-col items-center justify-center gap-1">
          {actions}
        </div>
      ) : null}
    </li>
  );
}

/** Maps a tone to the dot's background (the dot is the only coloured element — labels stay AA-safe). */
const DOT_TONE_RING: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  info: "bg-info",
  danger: "bg-destructive",
  neutral: "bg-border",
};

/**
 * A short labelled edge between boxes — the success spine carries no label (it is the default
 * fall-through); a non-default edge (failure branch, or an explicit success target) renders this small
 * tinted chip so the diagram reads as a graph without free-drawn arrows.
 */
export function WorkflowEdgeLabel({
  tone = "neutral",
  children,
}: {
  tone?: StatusTone;
  children: ReactNode;
}) {
  return (
    <li className="relative flex gap-3 pb-1">
      <span className="flex w-2.5 justify-center">
        <span className="h-full w-px bg-border" aria-hidden />
      </span>
      <StatusBadge tone={tone}>{children}</StatusBadge>
    </li>
  );
}

/**
 * A terminal marker for the end of a spine (END_SUCCESS / STOP_FAIL / ESCALATE / COMPENSATE). Rendered
 * as a small dot + label, closing the diagram so a reader sees where the run ends.
 */
export function WorkflowTerminal({
  tone = "neutral",
  label,
}: {
  tone?: StatusTone;
  label: ReactNode;
}) {
  return (
    <li className="relative flex items-center gap-3">
      <span
        className={cn(
          "size-2.5 shrink-0 rounded-full ring-2 ring-background",
          DOT_TONE_RING[tone],
        )}
        aria-hidden
      />
      <StatusBadge tone={tone}>{label}</StatusBadge>
    </li>
  );
}
