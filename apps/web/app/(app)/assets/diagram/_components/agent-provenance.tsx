"use client";

import { CpuChipIcon } from "@heroicons/react/24/outline";
import type { InfraNodeStatus } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { cn } from "@/lib/utils";

/**
 * Provenance affordances for AGENT-sourced nodes (ADR-0074 §3) — shared by the Servers table row and
 * the drill-in panel so both surfaces read identically. The reporting agent self-populates inventory;
 * these mark which nodes are machine-reported and how fresh that report is.
 *
 * ponytail: relative time reuses the shared `useFormatters().relative` (next-intl, locale-aware) — no
 * bespoke `Intl.RelativeTimeFormat`. Staleness is conveyed in muted TEXT (never small coloured text),
 * honouring ADR-0049: the status hue stays reserved for badges/icons, not body copy.
 */

/** A compact "Agent-reported" badge. Render only when `source === 'AGENT'` (the caller gates). */
export function AgentBadge({ className }: { className?: string }) {
  const t = useTranslations("infra.agent");
  return (
    <Badge variant="outline" className={cn("gap-1", className)}>
      <CpuChipIcon className="size-3" aria-hidden />
      {t("badge")}
    </Badge>
  );
}

/**
 * The reporting source + a relative "reported 3m ago" freshness. When the host is OFFLINE the report is
 * stale, so the label reads "… · stale" (still muted — see the file note). Renders nothing useful when
 * the node has never reported (no `lastReportedAt`), so callers should only mount it for AGENT nodes.
 */
export function AgentFreshness({
  reportingSource,
  lastReportedAt,
  status,
  className,
}: {
  reportingSource: string | null;
  lastReportedAt: string | null;
  status: InfraNodeStatus;
  className?: string;
}) {
  const t = useTranslations("infra.agent");
  const { relative, dateTime } = useFormatters();
  const stale = status === "OFFLINE";

  return (
    <span
      className={cn(
        "inline-flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      {reportingSource ? (
        <span className="truncate font-mono">{reportingSource}</span>
      ) : null}
      {lastReportedAt ? (
        <span title={dateTime(lastReportedAt)}>
          {stale
            ? t("staleReported", { time: relative(lastReportedAt) })
            : t("reported", { time: relative(lastReportedAt) })}
        </span>
      ) : null}
    </span>
  );
}
