"use client"

import * as React from "react"
import { Tabs as TabsPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * Tabs — a new shadcn-style primitive on the vendored, unified `radix-ui` package (the same
 * dependency `select.tsx` already imports, so this adds NO new package). It's the segmented
 * view/scope switcher the Reports screen wears (All · Assets · Access · Stock).
 *
 * Styling is the calm "underline" register rather than a pill row: a quiet bottom border on the
 * list, and an ACTIVE trigger that gets a 2px underline + a foreground label. The underline colour
 * is deliberately NOT baked in here — a caller passes an `indicatorClassName` (a token-backed
 * `data-[state=active]:border-*` class, e.g. a pillar hue) so the active tab can wear a route's
 * pillar tint without this primitive knowing which pillar it is (ADR-0049). With no override it
 * falls back to the brand `--primary` underline. The label always stays on `--foreground` /
 * `--muted-foreground` — the hue is a 2px rule (a state indicator), never readable coloured text.
 */
function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        // A quiet baseline rule the active trigger's underline sits on. Horizontally scrollable
        // on narrow viewports so a long tab row never clips on mobile.
        "inline-flex h-9 w-full items-center justify-start gap-1 overflow-x-auto border-b border-border",
        className
      )}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  indicatorClassName,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger> & {
  /**
   * The active-underline colour, as a `data-[state=active]:border-*` utility (token-backed). The
   * Reports screen passes a pillar tint so the active tab wears the route's hue; omit for the
   * brand `--primary` underline. The colour is a 2px state rule only — never the label colour.
   */
  indicatorClassName?: string
}) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        // Calm by default → foreground + a tinted underline when active. The -mb-px pulls the
        // 2px border over the list's 1px baseline so the active rule reads crisp. Full state set:
        // hover lifts the muted label to foreground; focus shows the indigo ring; disabled dims.
        "-mb-px inline-flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        // Default active underline is the brand --primary; a caller can override with a pillar tint.
        indicatorClassName ?? "data-[state=active]:border-primary",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn(
        "flex-1 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
