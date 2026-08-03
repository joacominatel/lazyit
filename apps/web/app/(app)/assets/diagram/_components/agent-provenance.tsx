"use client";

import {
  CpuChipIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import type { InfraNodeStatus } from "@lazyit/shared";
import { isMajorBehind } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { useAgentPolicy } from "@/lib/api/hooks/use-agent-policy";
import { useInstanceVersion } from "@/lib/api/hooks/use-instance-version";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { cn } from "@/lib/utils";

/**
 * Provenance affordances for AGENT-sourced nodes (ADR-0074 §3) — shared by the Servers table row and
 * the detail modal's header so both surfaces read identically. The reporting agent self-populates
 * inventory; these mark which nodes are machine-reported and how fresh that report is.
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
 * A subtle "Agent outdated" hint (ADR-0074/0083, issue #907). Self-contained: it fetches the running
 * server version (`GET /instance/version`, cached ~1h so mounting it per-row is cheap — TanStack
 * dedupes) and renders NOTHING unless the node's reported `agentVersion` is a MAJOR behind the server.
 * `isMajorBehind` is fail-soft (a `dev`/unstamped agent or an unparseable version ⇒ never behind), so
 * this only surfaces on a real, meaningful contract gap — display-only, never a gate (v1). Caller gates
 * on `source === 'AGENT'`; a manual node has no `agentVersion`.
 */
export function AgentOutdatedBadge({
  agentVersion,
  className,
}: {
  agentVersion: string | null;
  className?: string;
}) {
  const t = useTranslations("infra.agent");
  const { data: version } = useInstanceVersion();
  const serverVersion = version?.current ?? null;
  if (!isMajorBehind(agentVersion, serverVersion)) return null;
  return (
    <Badge
      variant="warning"
      className={cn("gap-1", className)}
      title={t("outdatedTooltip", {
        agentVersion: agentVersion ?? "?",
        serverVersion: serverVersion ?? "?",
      })}
    >
      <ExclamationTriangleIcon className="size-3" aria-hidden />
      {t("outdated")}
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

/**
 * The policy ACKNOWLEDGEMENT (ADR-0074 §7 amendment, issue #1140) — *"Policy v7 · applied"* versus
 * *"Policy v8 · pending"*. Two integers, and the difference between having central configuration and
 * merely believing you have it.
 *
 * Three states, and the third is the one worth being careful about:
 *  - the node echoed the CURRENT revision ⇒ applied;
 *  - it echoed an OLDER one ⇒ pending, because this host has not checked in since the policy changed;
 *  - it has echoed NOTHING ⇒ render nothing at all. A manual node and an agent that predates the
 *    policy channel both look like this, and neither will ever echo one however long you wait — so
 *    showing "pending" would be a promise the estate cannot keep.
 *
 * Self-contained like {@link AgentOutdatedBadge}: it reads the instance policy (cached ~5 min, so
 * mounting it per panel is cheap) rather than making the caller thread the revision through.
 */
export function AgentPolicyBadge({
  policyRevision,
  className,
}: {
  policyRevision: number | null | undefined;
  className?: string;
}) {
  const t = useTranslations("infra.agent");
  const { data } = useAgentPolicy();
  if (policyRevision === null || policyRevision === undefined) return null;
  if (data === undefined) return null;
  const applied = policyRevision >= data.revision;
  return (
    <Badge
      variant="outline"
      className={cn("gap-1", className)}
      title={t(applied ? "policyAppliedTooltip" : "policyPendingTooltip", {
        revision: policyRevision,
        current: data.revision,
      })}
    >
      {t(applied ? "policyApplied" : "policyPending", {
        revision: applied ? policyRevision : data.revision,
      })}
    </Badge>
  );
}
