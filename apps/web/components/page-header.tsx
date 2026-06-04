import type { ComponentType, ReactNode } from "react";
import type { Pillar } from "@/components/pillar-scope";
import { cn } from "@/lib/utils";

/**
 * Static, scanner-safe tinted-chip classes per pillar (ADR-0049). The chip holds a
 * DECORATIVE glyph (`aria-hidden`, ≥24px-equivalent) so the pillar hue is safe as both the
 * `/10` tint and the glyph colour — readable text (the title) stays on `--foreground`. Same
 * mapping the dashboard PillarCard wears, so a list page carries its pillar identity straight
 * from the dashboard card to the full page. Full strings so the Tailwind v4 scanner keeps them.
 */
const PILLAR_CHIP: Record<Pillar, string> = {
  inventory: "bg-pillar-inventory/10 text-pillar-inventory",
  access: "bg-pillar-access/10 text-pillar-access",
  knowledge: "bg-pillar-knowledge/10 text-pillar-knowledge",
  manage: "bg-pillar-manage/10 text-pillar-manage",
};

interface PageHeaderProps {
  /**
   * The page title. Rendered at ONE fixed scale (text-2xl) for every page —
   * this is the single source of truth that kills the text-2xl-vs-text-3xl
   * drift across list, detail, new and edit screens.
   */
  title: ReactNode;
  /**
   * Optional pillar identity. When set together with {@link icon}, a tinted icon chip
   * (`bg-pillar-*/10` + the ≥24px glyph) renders to the left of the title, carrying the
   * route's pillar colour from the dashboard card to the list page. Decorative only — the
   * chip is `aria-hidden` and the title text stays on `--foreground` (ADR-0049 §4 AA rule).
   */
  pillar?: Pillar;
  /** A heroicons/24/outline icon for the pillar chip. Renders only when {@link pillar} is set too. */
  icon?: ComponentType<{ className?: string }>;
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
  pillar,
  icon: Icon,
  subtitle,
  breadcrumb,
  actions,
  badge,
  className,
}: PageHeaderProps) {
  // The pillar chip renders only when BOTH a pillar and an icon are supplied — a tinted,
  // decorative anchor that mirrors the dashboard card's chip so the identity reads continuous.
  const showChip = pillar != null && Icon != null;
  return (
    <div className={cn("space-y-2", className)}>
      {breadcrumb ? <div>{breadcrumb}</div> : null}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-3">
            {showChip ? (
              <span
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-lg",
                  PILLAR_CHIP[pillar],
                )}
                aria-hidden
              >
                <Icon className="size-5" />
              </span>
            ) : null}
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
