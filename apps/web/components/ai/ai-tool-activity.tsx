"use client";

import type { AiEntityRef, AiMessagePart } from "@lazyit/shared";
import {
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  ExclamationCircleIcon,
  NoSymbolIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { linkableRefs } from "@/lib/ai/entity-href";
import { plainText } from "@/lib/ai/untrusted-text";
import { cn } from "@/lib/utils";
import { toolDisplayName, useEntityTypeLabel } from "./ai-labels";

type ToolPart = Extract<AiMessagePart, { type: "tool" }>;

const KNOWN_STATUSES = new Set([
  "EXECUTING",
  "SUCCEEDED",
  "FAILED",
  "DENIED",
  "AWAITING_APPROVAL",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
  "OUTCOME_UNKNOWN",
]);

function StatusIcon({ status }: { status: string }) {
  const cls = "size-3.5 shrink-0";
  if (status === "SUCCEEDED") return <CheckIcon className={cn(cls, "text-success")} aria-hidden />;
  if (status === "FAILED" || status === "OUTCOME_UNKNOWN")
    return <ExclamationCircleIcon className={cn(cls, "text-destructive-text")} aria-hidden />;
  if (status === "DENIED" || status === "REJECTED" || status === "CANCELLED" || status === "EXPIRED")
    return <NoSymbolIcon className={cn(cls, "text-muted-foreground")} aria-hidden />;
  return <ClockIcon className={cn(cls, "text-muted-foreground")} aria-hidden />;
}

/** "Open ‹entity›" chips for a result's entity refs — the web builds every href. */
export function AiEffectChips({ refs, opened }: { refs: readonly AiEntityRef[]; opened: boolean }) {
  const t = useTranslations("ai.effects");
  const entityLabel = useEntityTypeLabel();
  const links = linkableRefs(refs);
  if (links.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-wrap gap-1.5">
      {links.map(({ ref, href }) => {
        const label = plainText(ref.label ?? "") || entityLabel(ref.type);
        return (
          <li key={href}>
            <Link
              href={href}
              className="inline-flex min-h-7 items-center gap-1 rounded-sm border border-border bg-background px-2 text-xs font-medium hover:bg-muted"
            >
              {opened && ref.op === "navigate" ? t("opened", { label }) : t("open", { label })}
              <ArrowTopRightOnSquareIcon className="size-3" aria-hidden />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One tool call as a ledger-tape line (frontend.md §5.2 `ToolActivity`): status, the tool, an expandable
 * summary and the "Open" chips of what it touched. Every string is escaped React text; untrusted wrappers
 * are stripped, never rendered as HTML.
 */
export function AiToolActivity({ part, navigated }: { part: ToolPart; navigated: boolean }) {
  const t = useTranslations("ai.tools");
  const [open, setOpen] = useState(false);
  const status = KNOWN_STATUSES.has(part.status) ? part.status : "unknown";
  const tool = toolDisplayName(part.name);
  const summary = part.result?.summary ? plainText(part.result.summary) : "";
  const errorMessage = part.result?.error ? plainText(part.result.error.message) : "";
  const detail = summary || errorMessage;

  return (
    <div className="text-xs">
      <div className="flex items-center gap-1.5 font-mono text-muted-foreground">
        <StatusIcon status={part.status} />
        <span className="min-w-0 truncate">{t(`generic.${status}`, { tool })}</span>
        {detail && (
          <button
            type="button"
            className="ml-auto inline-flex min-h-6 items-center gap-0.5 rounded-sm px-1 font-sans text-muted-foreground hover:text-foreground"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} aria-hidden />
            {open ? t("hideDetails") : t("showDetails")}
          </button>
        )}
      </div>
      {open && detail && (
        <p className="mt-1 ml-5 break-words whitespace-pre-wrap text-muted-foreground">{detail}</p>
      )}
      {part.status === "OUTCOME_UNKNOWN" && (
        <p className="mt-1 ml-5 text-destructive-text">{t("outcomeUnknown")}</p>
      )}
      {part.result && part.result.status === "ok" && part.result.kind !== "read" && (
        <div className="ml-5">
          <AiEffectChips refs={part.result.entityRefs} opened={navigated} />
        </div>
      )}
    </div>
  );
}
