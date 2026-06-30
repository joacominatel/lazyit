import Link from "next/link";
import type { ComponentType, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { Pillar } from "@/components/pillar-scope";

/**
 * EmptyState — the warm "nothing here yet" surface (ADR-0049 «Activated Restraint»).
 *
 * Composes Card + Button + a heroicon: a 3x icon inside a fully-rounded pillar-tinted
 * circle, a one-line invitation in the calm house voice, and an optional primary action.
 * Mounts with `rise-in`. Each pillar wears its own colour so an empty Assets list reads
 * teal, an empty Applications list reads indigo, etc.
 *
 * Used across the list pages (Assets / KB / Applications / Consumables / Users / Locations)
 * and the settings managers for the warm "nothing here yet" surface. Heroicons only
 * (ADR-0045); pass a 24/outline icon.
 *
 * AA: the chip is a decorative ≥24px glyph (exempt from text-AA), so pillar hue is safe as
 * both the tint and the glyph colour; the title/description text stays on --foreground.
 */

/** Static, scanner-safe chip classes per pillar (full strings; glyph is decorative). */
const CHIP_BY_PILLAR: Record<Pillar, string> = {
  inventory: "bg-pillar-inventory/10 text-pillar-inventory",
  access: "bg-pillar-access/10 text-pillar-access",
  knowledge: "bg-pillar-knowledge/10 text-pillar-knowledge",
  manage: "bg-pillar-manage/10 text-pillar-manage",
};

type EmptyStateAction =
  | { label: string; href: string; onClick?: never }
  | { label: string; onClick: () => void; href?: never };

export function EmptyState({
  icon: Icon,
  title,
  description,
  pillar = "access",
  action,
  className,
  children,
}: {
  /** A heroicons/24/outline icon component. */
  icon: ComponentType<{ className?: string }>;
  title: string;
  description?: ReactNode;
  /** The pillar whose colour the icon chip wears. Defaults to brand-indigo Access. */
  pillar?: Pillar;
  /** Optional primary action — a link or a click handler. */
  action?: EmptyStateAction;
  className?: string;
  /** Extra content below the action (e.g. a secondary link). */
  children?: ReactNode;
}) {
  return (
    <Card
      className={cn(
        "animate-rise-in items-center gap-3 px-6 py-10 text-center",
        className,
      )}
    >
      <span
        className={cn(
          "flex size-14 items-center justify-center rounded-full",
          CHIP_BY_PILLAR[pillar],
        )}
        aria-hidden
      >
        <Icon className="size-7" />
      </span>
      <div className="space-y-1">
        {/* ponytail: the warm "nothing here yet" title carries the Ledger display face (Redaction);
            bumped text-sm → text-base so the lightly-engraved 400 weight stays legible. */}
        <p className="font-display text-base text-foreground">{title}</p>
        {description && (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action &&
        (action.href ? (
          <Button asChild size="sm" className="mt-1">
            <Link href={action.href}>{action.label}</Link>
          </Button>
        ) : (
          <Button size="sm" className="mt-1" onClick={action.onClick}>
            {action.label}
          </Button>
        ))}
      {children}
    </Card>
  );
}
