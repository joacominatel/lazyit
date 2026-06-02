import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * StatusBadge — the single, token-driven primitive for status pills across the app.
 *
 * Every status surface should map its domain states to one of five tones; the tones are the
 * only place a status color is decided, so "green = good" / "amber = attention" stays identical
 * on every screen and in both themes. Colors come from the semantic tokens in globals.css
 * (`--success / --warning / --info / --destructive`), each paired with an AA-verified
 * foreground, so the pill fills SOLID and is always readable (a tinted amber-on-bone pill
 * cannot clear AA — that's why this fills solid rather than tinting like the destructive Badge).
 *
 * - `tone`: success | warning | info | danger | neutral. danger → `--destructive`,
 *   neutral → the muted `secondary` surface.
 * - `dot`: prepend a small status dot (uses {@link StatusDot}).
 * - children: the label.
 */

export type StatusTone = "success" | "warning" | "info" | "danger" | "neutral"

const statusBadgeVariants = cva(
  "inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1.5 rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      tone: {
        success: "bg-success text-success-foreground",
        warning: "bg-warning text-warning-foreground",
        info: "bg-info text-info-foreground",
        // danger maps to the existing --destructive token (AA-verified solid fill).
        danger: "bg-destructive text-white",
        // neutral is the muted, non-status state (e.g. retired / unknown / inactive).
        neutral: "bg-secondary text-secondary-foreground",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  }
)

/** Maps a tone to the token-backed background color used by {@link StatusDot}. */
const DOT_TONE: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  info: "bg-info",
  danger: "bg-destructive",
  neutral: "bg-muted-foreground/40",
}

/**
 * A small standalone status dot. Useful inside a neutral container (e.g. an outline Badge or a
 * table cell) when a full colored pill would be too loud but the state still needs a color cue.
 */
function StatusDot({
  tone = "neutral",
  className,
  ...props
}: React.ComponentProps<"span"> & { tone?: StatusTone }) {
  return (
    <span
      data-slot="status-dot"
      aria-hidden="true"
      className={cn("size-1.5 shrink-0 rounded-full", DOT_TONE[tone], className)}
      {...props}
    />
  )
}

function StatusBadge({
  tone = "neutral",
  dot = false,
  className,
  children,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof statusBadgeVariants> & { dot?: boolean }) {
  return (
    <span
      data-slot="status-badge"
      data-tone={tone}
      className={cn(statusBadgeVariants({ tone }), className)}
      {...props}
    >
      {dot && (
        <StatusDot
          tone={tone ?? "neutral"}
          // On a solid pill the dot must read against the fill, so tint it with the pill's
          // own foreground instead of the (same-color) token background.
          className="bg-current opacity-80"
        />
      )}
      {children}
    </span>
  )
}

export { StatusBadge, StatusDot, statusBadgeVariants }
