"use client";

import type { AiMessagePart, AiToolInvocationStatus } from "@lazyit/shared";
import { BoltIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { entityHref } from "@/lib/ai/entity-href";
import { isKnownWarning } from "@/lib/ai/error-kinds";
import { presentPreview } from "@/lib/ai/preview";
import { plainText } from "@/lib/ai/untrusted-text";
import { cn } from "@/lib/utils";
import { ApprovalValue, approvalStage, type ApprovalStage } from "./ai-approval-card";
import { useEntityTypeLabel, usePreviewFieldLabel } from "./ai-labels";

type ApprovalPart = Extract<AiMessagePart, { type: "approval" }>;

const TONE: Partial<Record<ApprovalStage, StatusTone>> = {
  executed: "success",
  failed: "danger",
  approved: "info",
};

/**
 * A write approved automatically (auto-approve mode, #1376): the compact record of what was applied,
 * never a pending card. Drawn from the same server-built preview a card uses — the action sentence, the
 * target with its link, before → after — and marked "Applied automatically". Nothing here decides
 * anything; the server only auto-approves ordinary writes, everything critical still shows a card.
 */
export function AiAutoAppliedCard({
  part,
  callStatus,
  failureMessage,
}: {
  part: ApprovalPart;
  callStatus?: AiToolInvocationStatus;
  failureMessage?: string;
}) {
  const t = useTranslations("ai.approval");
  const tAuto = useTranslations("ai.approval.auto");
  const tWarn = useTranslations("ai.approval.warnings");
  const entityLabel = useEntityTypeLabel();
  const fieldLabel = usePreviewFieldLabel();
  const titleId = useId();

  const preview = part.request.preview;
  const model = presentPreview(preview);
  const stage = approvalStage(part.outcome, callStatus, null);
  const target = preview.target;
  const targetHref = target ? entityHref(target) : null;
  const targetLabel = target ? plainText(target.label ?? "") || entityLabel(target.type) : null;

  return (
    <section
      role="group"
      aria-labelledby={titleId}
      className="rounded-md border border-border bg-card text-xs text-card-foreground"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <h3 id={titleId} className="flex min-w-0 items-center gap-1.5 font-medium tracking-wide uppercase">
          <BoltIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{tAuto("title")}</span>
          {target && <span className="truncate text-muted-foreground normal-case">· {entityLabel(target.type)}</span>}
        </h3>
        <StatusBadge tone={TONE[stage] ?? "neutral"}>{t(`states.${stage}`)}</StatusBadge>
      </header>
      <div className="space-y-2 px-3 py-2">
        <p className={cn("text-sm font-medium", model.action?.untrusted && "italic")}>
          {model.action ? model.action.text : t("noAction")}
        </p>
        {target && targetLabel && (
          <p className="text-muted-foreground">
            {t("target")}:{" "}
            {targetHref ? (
              <Link href={targetHref} className="font-medium text-primary underline-offset-2 hover:underline">
                {targetLabel}
              </Link>
            ) : (
              <span className="font-medium text-foreground">{targetLabel}</span>
            )}
          </p>
        )}
        {model.rows.length > 0 && (
          <dl className="divide-y divide-border border-y border-border">
            {model.rows.map((row, index) => (
              <div key={`${row.field}-${index}`} className="grid grid-cols-[minmax(0,2fr)_minmax(0,5fr)] gap-2 py-1">
                <dt className="text-muted-foreground">{fieldLabel(row.field)}</dt>
                <dd className="min-w-0">
                  {row.before !== null && (
                    <>
                      <span className="sr-only">{t("before")}: </span>
                      <span className="text-muted-foreground line-through decoration-muted-foreground/50">
                        <ApprovalValue value={row.before} />
                      </span>
                      <span aria-hidden className="px-1 text-muted-foreground">→</span>
                      <span className="sr-only">{t("after")}: </span>
                    </>
                  )}
                  <ApprovalValue value={row.after} />
                </dd>
              </div>
            ))}
          </dl>
        )}
        {preview.warnings.length > 0 && (
          <ul className="space-y-0.5 text-muted-foreground">
            {preview.warnings.map((code) => (
              <li key={code}>{isKnownWarning(code) ? tWarn(code) : tWarn("unknown", { code })}</li>
            ))}
          </ul>
        )}
        {stage === "failed" ? (
          <p className="text-destructive-text">
            {t("failedNote", { message: plainText(failureMessage ?? "") || "—" })}
          </p>
        ) : (
          <p className="text-muted-foreground">{tAuto("note")}</p>
        )}
      </div>
    </section>
  );
}
