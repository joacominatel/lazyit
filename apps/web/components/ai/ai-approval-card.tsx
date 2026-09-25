"use client";

import type { AiMessagePart, AiToolInvocationStatus } from "@lazyit/shared";
import {
  ExclamationTriangleIcon,
  EyeSlashIcon,
  LockClosedIcon,
  ShieldExclamationIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { RequestIdNote } from "@/components/request-id-note";
import { entityHref, linkableRefs } from "@/lib/ai/entity-href";
import {
  isKnownWarning,
  STEP_UP_WARNINGS,
  type DecisionErrorKind,
} from "@/lib/ai/error-kinds";
import { presentPreview, type PreviewValue } from "@/lib/ai/preview";
import { plainText } from "@/lib/ai/untrusted-text";
import type { DecisionResult } from "@/lib/api/hooks/use-ai-turn";
import { cn } from "@/lib/utils";
import { useEntityTypeLabel, usePreviewFieldLabel } from "./ai-labels";
import { AiPreviewTable } from "./ai-preview-table";

type ApprovalPart = Extract<AiMessagePart, { type: "approval" }>;

/** What the card shows as its stamp. */
export type ApprovalStage =
  | "pending"
  | "approving"
  | "rejecting"
  | "executed"
  | "failed"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled";

const STAGE_TONE: Record<ApprovalStage, StatusTone> = {
  pending: "warning",
  approving: "info",
  rejecting: "info",
  executed: "success",
  failed: "danger",
  approved: "info",
  rejected: "neutral",
  expired: "neutral",
  cancelled: "neutral",
};

/** The card's stage from the decision and, once approved, the call's execution status. Pure. */
export function approvalStage(
  outcome: ApprovalPart["outcome"],
  callStatus: AiToolInvocationStatus | undefined,
  busy: "approve" | "reject" | null,
): ApprovalStage {
  if (outcome === null) {
    if (busy === "approve") return "approving";
    if (busy === "reject") return "rejecting";
    return "pending";
  }
  if (outcome === "approved") {
    if (callStatus === "SUCCEEDED") return "executed";
    if (callStatus === "FAILED" || callStatus === "OUTCOME_UNKNOWN") return "failed";
    return "approved";
  }
  return outcome;
}

/**
 * Enter in the password field approves THIS card — once: a held key's auto-repeat and an IME composition
 * never submit (a repeat would send the same password again after a refusal cleared it).
 */
export function isPasswordSubmitKey(e: {
  key: string;
  repeat: boolean;
  nativeEvent?: { isComposing?: boolean };
}): boolean {
  return e.key === "Enter" && !e.repeat && e.nativeEvent?.isComposing !== true;
}

/** One before or after value of a preview row, as plain escaped text. */
export function ApprovalValue({ value }: { value: PreviewValue | null }) {
  const t = useTranslations("ai.approval");
  const format = useFormatter();
  if (value === null || value.kind === "empty") {
    return <span className="text-muted-foreground">{t("empty")}</span>;
  }
  switch (value.kind) {
    case "redacted":
      return (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          <EyeSlashIcon className="size-3.5" aria-hidden />
          {t("redacted")}
        </span>
      );
    case "boolean":
      return <span>{value.value ? t("yes") : t("no")}</span>;
    case "number":
      return <span className="font-mono tabular-nums">{format.number(value.value)}</span>;
    case "date":
      return (
        <span className="font-mono tabular-nums">
          {format.dateTime(new Date(value.iso), { dateStyle: "medium", timeStyle: "short" })}
        </span>
      );
    case "text":
      return (
        <span
          className={cn("break-words whitespace-pre-wrap", value.untrusted && "italic")}
          title={value.untrusted ? t("quoted") : undefined}
        >
          {value.text}
        </span>
      );
  }
}

interface ApprovalCardProps {
  part: ApprovalPart;
  /** The execution status of the same call (from its tool line), once approved. */
  callStatus?: AiToolInvocationStatus;
  /** The failure message of the call, when it failed after approval. */
  failureMessage?: string;
  onDecide: (
    toolCallId: string,
    decision: "approve" | "reject",
    password?: string,
  ) => Promise<DecisionResult>;
  /**
   * Inside the paged card (#1409): no own border (the pager draws it), `locked` disables both buttons
   * while a bulk action runs, `busyOverride` stamps a decision the pager sent for this card, and
   * `externalError` is a refusal of such a decision, shown and acted on as if the card had sent it.
   */
  embedded?: boolean;
  locked?: boolean;
  busyOverride?: "approve" | "reject" | null;
  externalError?: DecisionErrorKind | null;
}

/**
 * The approval card (frontend.md §5.3; tools-and-execution.md §9). Rendered ONLY from the server-built
 * preview — never from model prose: the plain-language `action` sentence first, the target, before →
 * after, the warnings (every shared code localized, an unknown one generically), the untrusted-source
 * banner and, when the server asks for it, the password step-up. Elevated cards are visually distinct.
 * Approve is never autofocused and no global key approves anything; each click disables both buttons
 * until the server answers. One card, one decision — several cards of one step are paged by
 * `AiApprovalPager` (#1409), whose "Approve all" still sends one decision per card and never covers a
 * card that needs the password, is sensitive, or whose last decision was refused.
 */
export function AiApprovalCard({
  part,
  callStatus,
  failureMessage,
  onDecide,
  embedded = false,
  locked = false,
  busyOverride = null,
  externalError = null,
}: ApprovalCardProps) {
  const t = useTranslations("ai.approval");
  const tWarn = useTranslations("ai.approval.warnings");
  const format = useFormatter();
  const entityLabel = useEntityTypeLabel();
  const fieldLabel = usePreviewFieldLabel();
  const titleId = useId();
  const passwordId = useId();

  const { request, outcome } = part;
  const preview = request.preview;
  const model = presentPreview(preview);
  // A list of records (a batch's rows, #1387) is a table below the field rows, not a field row.
  const fieldRows = model.rows.filter((row) => row.records === undefined);
  const tableRows = model.rows.filter((row) => row.records !== undefined);
  const elevated = request.elevated || preview.elevated;

  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<DecisionErrorKind | null>(null);
  const [addedWarnings, setAddedWarnings] = useState<string[]>([]);
  const [forceStepUp, setForceStepUp] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);

  // Count down a step-up rate limit so Approve re-enables by itself.
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  const inFlight = busy ?? busyOverride;
  const stage = approvalStage(outcome, callStatus, inFlight);
  const pending = outcome === null;
  const stepUp = pending && (request.stepUpRequired || preview.stepUpRequired || forceStepUp);
  const unavailable = error?.kind === "stepUpUnavailable";
  const blocked = secondsLeft > 0;
  const canApprove =
    pending && inFlight === null && !locked && !unavailable && !blocked && (!stepUp || password.length > 0);

  const warnings = Array.from(new Set([...preview.warnings, ...addedWarnings]));
  const untrusted = linkableRefs([...request.untrustedSources, ...preview.untrustedSources]);
  const hasUntrusted = request.untrustedSources.length + preview.untrustedSources.length > 0;
  const target = preview.target;
  const targetHref = target ? entityHref(target) : null;
  const targetLabel = target ? plainText(target.label ?? "") || entityLabel(target.type) : null;

  async function decide(decision: "approve" | "reject") {
    setBusy(decision);
    setError(null);
    const typed = decision === "approve" && stepUp ? password : undefined;
    // The password is used for exactly one attempt: cleared now, whatever the answer.
    setPassword("");
    let result: DecisionResult;
    try {
      result = await onDecide(request.toolCallId, decision, typed);
    } finally {
      setBusy(null);
    }
    if (result.ok) return;
    applyError(result.error);
  }

  function applyError(kind: DecisionErrorKind) {
    setError(kind);
    if (kind.kind === "stepUpRequired") {
      setForceStepUp(true);
      if (kind.addedWarnings.length > 0) setAddedWarnings((prev) => [...prev, ...kind.addedWarnings]);
    }
    if (kind.kind === "previewChanged") {
      setAddedWarnings((prev) => [...prev, ...kind.addedWarnings]);
    }
    if (kind.kind === "stepUpRateLimited") {
      setSecondsLeft(Math.max(1, Math.ceil(kind.retryAfterSec ?? 30)));
    }
  }

  function errorText(kind: DecisionErrorKind): string {
    if (kind.kind === "stepUpRateLimited") {
      return blocked
        ? t("errors.stepUpRateLimited", { seconds: secondsLeft })
        : t("errors.stepUpRateLimitedNoTime");
    }
    return t(`errors.${kind.kind}`);
  }

  // A refusal of a decision the pager sent for this card lands here like the card's own (#1409).
  useEffect(() => {
    if (externalError) applyError(externalError);
  }, [externalError]);

  const expiresAt = new Date(request.expiresAt);

  return (
    <section
      role="group"
      aria-labelledby={titleId}
      className={cn(
        "bg-card text-card-foreground",
        embedded
          ? elevated && "border-l-4 border-destructive/60"
          : ["rounded-md border", elevated ? "border-destructive/60 border-l-4" : "border-border"],
      )}
    >
      <header className="flex items-start justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h3 id={titleId} className="flex items-center gap-1.5 text-xs font-medium tracking-wide uppercase">
            {elevated && <ShieldExclamationIcon className="size-4 text-destructive-text" aria-hidden />}
            {t(`classes.${elevated ? "elevated" : "write"}`)}
            {target && (
              <span className="text-muted-foreground normal-case">· {entityLabel(target.type)}</span>
            )}
          </h3>
        </div>
        <StatusBadge tone={STAGE_TONE[stage]}>{t(`states.${stage}`)}</StatusBadge>
      </header>

      <div className="space-y-3 px-3 py-3 text-sm">
        <p className={cn("font-medium", model.action?.untrusted && "italic")}>
          {model.action ? model.action.text : t("noAction")}
        </p>

        {target && targetLabel && (
          <p className="text-xs text-muted-foreground">
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

        {hasUntrusted && (
          <div role="note" className="rounded-sm border border-warning bg-muted/50 px-2.5 py-2 text-xs">
            <p className="flex items-center gap-1.5 font-medium">
              <ExclamationTriangleIcon className="size-4 text-warning-text" aria-hidden />
              {t("untrustedTitle")}
            </p>
            <p className="mt-1 text-muted-foreground">{t("untrustedBody")}</p>
            {untrusted.length > 0 && (
              <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                {untrusted.map(({ ref, href }) => (
                  <li key={href}>
                    <Link href={href} className="text-primary underline-offset-2 hover:underline">
                      {plainText(ref.label ?? "") || entityLabel(ref.type)}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {elevated && pending && <p className="text-xs text-muted-foreground">{t("elevatedNote")}</p>}

        {fieldRows.length > 0 && (
          <dl className="divide-y divide-border border-y border-border">
            {fieldRows.map((row, index) => (
              <div key={`${row.field}-${index}`} className="grid grid-cols-[minmax(0,2fr)_minmax(0,5fr)] gap-2 py-1.5">
                <dt className="text-xs text-muted-foreground">{fieldLabel(row.field)}</dt>
                <dd className="min-w-0 text-xs">
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

        {model.notices.map((notice) => (
          <p key={notice} role="note" className="flex items-start gap-1.5 rounded-sm bg-muted/50 px-1.5 py-1 text-xs">
            <ExclamationTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-warning-text" aria-hidden />
            {t(`notices.${notice}`)}
          </p>
        ))}

        {tableRows.map((row, index) => (
          <AiPreviewTable key={`${row.field}-${index}`} field={row.field} records={row.records!} />
        ))}

        {preview.impacted.length > 0 && (
          <ul className="space-y-1 text-xs">
            {preview.impacted.map((impact) => (
              <li key={impact.type}>
                {t("impacted", { count: impact.count, type: entityLabel(impact.type).toLowerCase() })}
                {impact.sample.length > 0 && (
                  <span className="text-muted-foreground">
                    {" "}
                    ({impact.sample.map((s) => plainText(s.label ?? s.id)).join(", ")})
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {warnings.length > 0 && (
          <div>
            <p className="mb-1 text-xs font-medium">{t("warningsTitle")}</p>
            <ul className="space-y-1">
              {warnings.map((code) => {
                const isNew = addedWarnings.includes(code);
                const needsPassword = STEP_UP_WARNINGS.includes(code);
                return (
                  <li
                    key={code}
                    className={cn(
                      "flex items-start gap-1.5 rounded-sm px-1.5 py-1 text-xs",
                      isNew ? "bg-warning/20 ring-1 ring-warning" : "bg-muted/50",
                    )}
                  >
                    <ExclamationTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-warning-text" aria-hidden />
                    <span className="min-w-0 flex-1">
                      {isKnownWarning(code) ? tWarn(code) : tWarn("unknown", { code })}
                      {needsPassword && (
                        <span className="ml-1 inline-flex items-center gap-0.5 text-muted-foreground">
                          <LockClosedIcon className="size-3" aria-hidden />
                          {t("passwordRequired")}
                        </span>
                      )}
                    </span>
                    {isNew && <StatusBadge tone="warning">{t("newWarning")}</StatusBadge>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {addedWarnings.length > 0 && pending && (
          <p role="status" className="text-xs font-medium">
            {t("changed")}
          </p>
        )}

        {stepUp && (
          <div className="space-y-1">
            <Label htmlFor={passwordId} className="text-xs">
              {t("password")}
            </Label>
            <Input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={inFlight !== null || locked || unavailable}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                // Enter inside the password field is an explicit action on THIS card only.
                if (isPasswordSubmitKey(e) && canApprove) {
                  e.preventDefault();
                  void decide("approve");
                }
              }}
            />
            <p className="text-xs text-muted-foreground">{t("passwordHint")}</p>
          </div>
        )}

        {error && pending && (
          <div role="alert" className="text-xs text-destructive-text">
            <p>{errorText(error)}</p>
            {error.kind === "unknown" && <RequestIdNote requestId={error.requestId} className="mt-1" />}
          </div>
        )}

        {stage === "executed" && <p className="text-xs text-muted-foreground">{t("executedNote")}</p>}
        {stage === "failed" && (
          <p className="text-xs text-destructive-text">
            {t("failedNote", { message: plainText(failureMessage ?? "") || "—" })}
          </p>
        )}
        {stage === "rejected" && <p className="text-xs text-muted-foreground">{t("rejectedNote")}</p>}
        {stage === "expired" && <p className="text-xs text-muted-foreground">{t("expiredNote")}</p>}
        {stage === "cancelled" && <p className="text-xs text-muted-foreground">{t("cancelledNote")}</p>}

        {pending && (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            {!Number.isNaN(expiresAt.getTime()) && (
              <p className="text-xs text-muted-foreground">
                {t("expiresAt", { time: format.dateTime(expiresAt, { timeStyle: "short" }) })}
              </p>
            )}
            <div className="ml-auto flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={inFlight !== null || locked}
                onClick={() => void decide("reject")}
              >
                {t("reject")}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!canApprove}
                onClick={() => void decide("approve")}
              >
                {t("approve")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
