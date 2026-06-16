import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Callout — the single, token-driven primitive for inline status notices (warning / info / success).
 *
 * It exists to enforce ONE AA-correct token pairing in a single place. ADR-0049 (and globals.css)
 * documents that a *tinted* status text on a same-hue tint cannot reach WCAG AA on the warm "bone"
 * canvas — most sharply for amber. So a Callout NEVER colors its body text with the status hue:
 * the tint lives only in the background + border (`bg-{tone}/10` + `border-{tone}/30`) while the
 * readable text stays on `--card-foreground`, which clears AA on the faint tint in both themes.
 * The status hue is reserved for the (decorative, aria-hidden) leading icon — exactly the rule the
 * design system asks for. The semantic tokens already carry light/dark parity, so call sites that
 * adopt this can drop their old `dark:` palette overrides.
 *
 * When a compact chip or dot is the right element instead of a notice block, reach for
 * `StatusBadge` / `StatusDot` (components/ui/status-badge.tsx) — those fill solid for the same
 * AA reason.
 *
 * - `tone`: warning | info | success — picks the tint/border and the icon color.
 * - `icon`: optional leading icon element; it is rendered aria-hidden and tinted to the tone.
 */

export type CalloutTone = "warning" | "info" | "success";

const TONE_SURFACE: Record<CalloutTone, string> = {
  warning: "border-warning/30 bg-warning/10",
  info: "border-info/30 bg-info/10",
  success: "border-success/30 bg-success/10",
};

const TONE_ICON: Record<CalloutTone, string> = {
  warning: "text-warning",
  info: "text-info",
  success: "text-success",
};

function Callout({
  tone = "info",
  icon,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  tone?: CalloutTone;
  icon?: React.ReactNode;
}) {
  return (
    <div
      data-slot="callout"
      data-tone={tone}
      className={cn(
        "flex gap-2 rounded-md border p-3 text-card-foreground",
        TONE_SURFACE[tone],
        className,
      )}
      {...props}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className={cn("mt-0.5 shrink-0 [&>svg]:size-4", TONE_ICON[tone])}
        >
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export { Callout };
