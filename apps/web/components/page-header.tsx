import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageHeaderProps {
  /**
   * The page title. Rendered at ONE fixed scale (text-2xl) for every page —
   * this is the single source of truth that kills the text-2xl-vs-text-3xl
   * drift across list, detail, new and edit screens.
   */
  title: ReactNode;
  /** Optional one-line description under the title. */
  subtitle?: ReactNode;
  /**
   * Optional breadcrumb slot, rendered above the title. Pass the `<Breadcrumb />`
   * primitive (or any node). Replaces the per-page "Back to X" ghost button.
   */
  breadcrumb?: ReactNode;
  /**
   * Optional trailing action(s) — buttons, links, menus. Aligned to the title
   * row's end and wraps below the title on narrow viewports.
   */
  actions?: ReactNode;
  /** Optional content rendered inline beside the title (e.g. a status badge). */
  badge?: ReactNode;
  className?: string;
}

/**
 * Standard page header: an optional breadcrumb, then a title row (title + inline
 * badge on the left, actions on the right) and an optional subtitle.
 *
 * The title scale is fixed here on purpose. Pages must not re-implement the
 * title/subtitle/action block with their own `text-2xl`/`text-3xl` heading —
 * that copy-paste is exactly what drifted. Compose this instead.
 */
export function PageHeader({
  title,
  subtitle,
  breadcrumb,
  actions,
  badge,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn("space-y-2", className)}>
      {breadcrumb ? <div>{breadcrumb}</div> : null}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {badge}
          </div>
          {subtitle ? (
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}
