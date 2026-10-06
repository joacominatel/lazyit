"use client";

import { useTranslations } from "next-intl";
import { Skeleton } from "@/components/ui/skeleton";
import type { ImpactCount, OffboardingImpact } from "@/lib/offboarding/summary";
import { cn } from "@/lib/utils";

/**
 * The impact tiles at the top of the Offboarding sheet (#1532): four numbers read before anything
 * else — assets released, access revoked, consumables still out, and the account archived (history
 * kept). Counts are mono `tabular-nums`; a zero is muted so the tiles that matter stand out.
 *
 * Colour follows the pillar AA rule (ADR-0049, globals.css): pillar hue is a dot, never small text on
 * the canvas, so each verb label carries a pillar-tinted dot and stays on a readable text token. The
 * consumables verb turns `text-warning-text` (an AA-safe text token) while something is still out.
 * Loading → skeleton numbers; an unknown count (failed read, issue #601, or a refused consumables read)
 * shows "—", never a reassuring 0.
 */

type Tone = "inventory" | "access" | "neutral";

const DOT: Record<Tone, string> = {
  inventory: "bg-pillar-inventory",
  access: "bg-pillar-access",
  neutral: "bg-muted-foreground/50",
};

function Tile({
  tone,
  verb,
  value,
  label,
  loading,
  warn = false,
}: {
  tone: Tone;
  verb: string;
  /** A count (mono), a word (the account tile), or null for unknown. */
  value: ImpactCount | string;
  label: string;
  loading: boolean;
  /** Paint the verb with the warning text token (something is still owed). */
  warn?: boolean;
}) {
  const muted = value === 0 || value === null;
  return (
    <div className="grid gap-0.5 rounded-lg bg-card px-3 py-2.5 ring-1 ring-foreground/10">
      <span
        className={cn(
          "inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.06em] uppercase",
          warn ? "text-warning-text" : "text-muted-foreground",
        )}
      >
        <span className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])} aria-hidden />
        {verb}
      </span>
      {loading ? (
        <Skeleton className="my-1 h-6 w-10" />
      ) : typeof value === "string" ? (
        <span className="pt-1 text-base leading-7 font-medium text-foreground">
          {value}
        </span>
      ) : (
        <span
          className={cn(
            "font-mono text-2xl leading-8 font-semibold tracking-tight tabular-nums",
            muted ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {value ?? "—"}
        </span>
      )}
      <span className="truncate text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

export function OffboardingImpactTiles({
  impact,
  isLoading,
  isError,
}: {
  impact: OffboardingImpact;
  isLoading: boolean;
  isError: boolean;
}) {
  const t = useTranslations("users.offboarding");
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      {/* The tiles' "—" is visual; say why to a screen reader. */}
      {isError ? <p className="sr-only">{t("loadError.impact")}</p> : null}
      <Tile
        tone="inventory"
        verb={t("impact.assets.verb")}
        value={impact.assets}
        label={t("impact.assets.label", { count: impact.assets ?? 0 })}
        loading={isLoading}
      />
      <Tile
        tone="access"
        verb={t("impact.access.verb")}
        value={impact.access}
        label={t("impact.access.label", { count: impact.access ?? 0 })}
        loading={isLoading}
      />
      <Tile
        tone="inventory"
        verb={t("impact.consumables.verb")}
        value={impact.consumables}
        label={t("impact.consumables.label", { count: impact.consumables ?? 0 })}
        loading={isLoading}
        warn={(impact.consumables ?? 0) > 0}
      />
      <Tile
        tone="neutral"
        verb={t("impact.account.verb")}
        value={t("impact.account.value")}
        label={t("impact.account.label")}
        loading={false}
      />
    </div>
  );
}
