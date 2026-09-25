"use client";

import type { AiMessagePart } from "@lazyit/shared";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ExclamationCircleIcon,
  NoSymbolIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  bulkPlan,
  clampPage,
  EMPTY_PAGER_STATE,
  initialPage,
  isUndecided,
  nextUndecided,
  recordDecision,
  stopsBulk,
  type ApprovalPart,
  type BulkReport,
  type PagerState,
} from "@/lib/ai/approval-pages";
import type { DecisionErrorKind } from "@/lib/ai/error-kinds";
import type { DecisionResult } from "@/lib/api/hooks/use-ai-turn";
import { cn } from "@/lib/utils";
import { AiApprovalCard, approvalStage, type ApprovalStage } from "./ai-approval-card";
import { AiEffectChips } from "./ai-tool-activity";

type ToolPart = Extract<AiMessagePart, { type: "tool" }>;
type Decide = (toolCallId: string, decision: "approve" | "reject", password?: string) => Promise<DecisionResult>;

function PageMark({ stage }: { stage: ApprovalStage }) {
  const cls = "size-3 shrink-0";
  if (stage === "executed" || stage === "approved")
    return <CheckIcon className={cn(cls, "text-success")} aria-hidden />;
  if (stage === "failed") return <ExclamationCircleIcon className={cn(cls, "text-destructive-text")} aria-hidden />;
  if (stage === "rejected" || stage === "expired" || stage === "cancelled")
    return <NoSymbolIcon className={cls} aria-hidden />;
  return null;
}

const PAGE_TONE: Partial<Record<ApprovalStage, string>> = {
  executed: "border-success text-foreground",
  approved: "border-success text-foreground",
  failed: "border-destructive text-destructive-text",
  rejected: "border-border text-muted-foreground",
  expired: "border-border text-muted-foreground",
  cancelled: "border-border text-muted-foreground",
};

interface AiApprovalPagerProps {
  parts: readonly ApprovalPart[];
  /** Every tool line of the transcript by call id: a page's execution status and result chips. */
  tools: ReadonlyMap<string, ToolPart>;
  navigated: readonly string[];
  onDecide: Decide;
}

/**
 * Several changes of one step as ONE paged card (#1409): "2 of 5", previous / next (buttons, or the arrow
 * keys on the page strip), each page the unchanged approval card. Deciding a page moves on to the next
 * change still waiting; decided pages keep their outcome. "Approve all" / "Reject all" send one decision
 * per change — the same call a page's button makes — and only for the changes `bulkPlan` finds eligible
 * (never one needing the password, a sensitive one, or one whose last decision was refused; one based
 * on other people's content is covered, its banner still on its page). A refusal stays on its own page. Every page stays mounted so a typed password or a shown error survives paging.
 */
export function AiApprovalPager({ parts, tools, navigated, onDecide }: AiApprovalPagerProps) {
  const t = useTranslations("ai.pager");
  const tApproval = useTranslations("ai.approval");
  const titleId = useId();
  const liveRef = useRef<HTMLParagraphElement>(null);

  const [pager, setPager] = useState<PagerState>(EMPTY_PAGER_STATE);
  const pagerRef = useRef(pager);
  const [page, setPage] = useState(() => initialPage(parts));
  const [inFlight, setInFlight] = useState<Readonly<Record<string, "approve" | "reject">>>({});
  const [bulk, setBulk] = useState<{ decision: "approve" | "reject"; done: number; total: number } | null>(
    null,
  );
  const [report, setReport] = useState<BulkReport | null>(null);
  /** A refusal of a decision the pager sent, handed to that page's card. */
  const [bulkErrors, setBulkErrors] = useState<Readonly<Record<string, DecisionErrorKind>>>({});

  const total = parts.length;
  // More changes joined this step (the assistant proposed the next ones): if the page shown is already
  // decided, open the first one still waiting.
  const [seenTotal, setSeenTotal] = useState(total);
  if (seenTotal !== total) {
    setSeenTotal(total);
    const shown = parts[clampPage(page, total)];
    if (shown && !isUndecided(shown, pager)) setPage(initialPage(parts, pager));
  }
  const current = clampPage(page, total);
  const partsRef = useRef(parts);
  // The latest parts and pager state for the async decision handlers (a bulk action outlives renders).
  useLayoutEffect(() => {
    partsRef.current = parts;
    pagerRef.current = pager;
  });

  const record = useCallback((id: string, decision: "approve" | "reject", result: DecisionResult) => {
    const next = recordDecision(pagerRef.current, id, decision, result);
    pagerRef.current = next;
    setPager(next);
    return next;
  }, []);

  const go = useCallback((to: number, announce = false) => {
    setPage(to);
    // After a decision, focus the page heading (never Approve) so the keyboard continues on the new page.
    if (announce) requestAnimationFrame(() => liveRef.current?.focus());
  }, []);

  /** A page's own Approve / Reject: sent as before, then on to the next change still waiting. */
  const decideOne: Decide = useCallback(
    async (id, decision, password) => {
      setInFlight((m) => ({ ...m, [id]: decision }));
      let result: DecisionResult;
      try {
        result = await onDecide(id, decision, password);
      } finally {
        setInFlight((m) => {
          const rest = { ...m };
          delete rest[id];
          return rest;
        });
      }
      const next = record(id, decision, result);
      if (result.ok) {
        const all = partsRef.current;
        const from = all.findIndex((p) => p.request.toolCallId === id);
        const to = nextUndecided(all, from === -1 ? 0 : from, next);
        if (to !== -1 && to !== from) go(to, true);
      }
      return result;
    },
    [onDecide, record, go],
  );

  const plan = bulkPlan(parts, pager);
  const busy = bulk !== null || Object.keys(inFlight).length > 0;
  const decidedCount = parts.filter((p) => !isUndecided(p, pager)).length;

  async function runBulk(decision: "approve" | "reject") {
    const ids = plan.eligible;
    if (ids.length === 0) return;
    setReport(null);
    setBulk({ decision, done: 0, total: ids.length });
    const failed: BulkReport["failed"] = [];
    let done = 0;
    let skipped = 0;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      setInFlight((m) => ({ ...m, [id]: decision }));
      let result: DecisionResult;
      try {
        result = await onDecide(id, decision);
      } catch {
        result = { ok: false, error: { kind: "unknown" } };
      } finally {
        setInFlight((m) => {
          const rest = { ...m };
          delete rest[id];
          return rest;
        });
      }
      record(id, decision, result);
      if (result.ok) {
        done++;
      } else {
        failed.push({ toolCallId: id, error: result.error });
        setBulkErrors((m) => ({ ...m, [id]: result.error }));
        if (stopsBulk(result.error)) {
          skipped = ids.length - i - 1;
          break;
        }
      }
      setBulk({ decision, done: i + 1, total: ids.length });
    }
    setBulk(null);
    setReport({ decision, done, failed, skipped });
    const to = nextUndecided(partsRef.current, current, pagerRef.current);
    if (to !== -1) go(to, true);
  }

  function onStripKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowLeft" && current > 0) {
      e.preventDefault();
      go(current - 1);
    } else if (e.key === "ArrowRight" && current < total - 1) {
      e.preventDefault();
      go(current + 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      go(0);
    } else if (e.key === "End") {
      e.preventDefault();
      go(total - 1);
    }
  }

  const stageOf = (part: ApprovalPart): ApprovalStage => {
    const id = part.request.toolCallId;
    return approvalStage(part.outcome, tools.get(id)?.status, inFlight[id] ?? pager.accepted[id] ?? null);
  };
  const pageOf = (id: string) => parts.findIndex((p) => p.request.toolCallId === id) + 1;

  return (
    <section
      role="group"
      aria-labelledby={titleId}
      className="rounded-md border border-border bg-card text-card-foreground"
    >
      <header className="space-y-2 border-b border-border px-3 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id={titleId} className="text-xs font-medium tracking-wide uppercase">
            {t("title")}
            <span className="text-muted-foreground normal-case"> · {t("count", { count: total })}</span>
          </h3>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("previous")}
              disabled={current === 0}
              onClick={() => go(current - 1)}
            >
              <ChevronLeftIcon className="size-4" aria-hidden />
            </Button>
            <p
              ref={liveRef}
              tabIndex={-1}
              aria-live="polite"
              aria-atomic="true"
              className="min-w-14 rounded-sm text-center font-mono text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span aria-hidden>{t("position", { page: current + 1, total })}</span>
              <span className="sr-only">{t("live", { page: current + 1, total })}</span>
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("next")}
              disabled={current >= total - 1}
              onClick={() => go(current + 1)}
            >
              <ChevronRightIcon className="size-4" aria-hidden />
            </Button>
          </div>
        </div>

        <div
          role="group"
          aria-label={t("pages")}
          onKeyDown={onStripKey}
          className="flex flex-wrap items-center gap-1"
        >
          {parts.map((part, index) => {
            const stage = stageOf(part);
            const active = index === current;
            return (
              <button
                key={part.request.toolCallId}
                type="button"
                aria-current={active ? "step" : undefined}
                aria-label={t("pageLabel", { page: index + 1, state: tApproval(`states.${stage}`) })}
                onClick={() => go(index)}
                className={cn(
                  "inline-flex h-7 min-w-7 items-center justify-center gap-0.5 rounded-sm border px-1.5 font-mono text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  PAGE_TONE[stage] ?? "border-border text-foreground",
                  active && "bg-muted font-semibold ring-1 ring-foreground/40",
                )}
              >
                <PageMark stage={stage} />
                {index + 1}
              </button>
            );
          })}
          <span className="ml-auto text-xs text-muted-foreground">
            {t("progress", { decided: decidedCount, total })}
          </span>
        </div>

        {plan.waiting > 0 && (
          <div className="space-y-1.5 pt-1">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || plan.eligible.length === 0}
                onClick={() => void runBulk("reject")}
              >
                {t("rejectAll", { count: plan.eligible.length })}
              </Button>
              {/* Outline, not oxblood: the page's own Approve stays the one primary action. */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || plan.eligible.length === 0}
                onClick={() => void runBulk("approve")}
              >
                {t("approveAll", { count: plan.eligible.length })}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("bulkCovers", { count: plan.eligible.length })}</p>
            {plan.excluded.length > 0 && (
              <div className="text-xs text-muted-foreground">
                <p>{t("excludedTitle")}</p>
                <ul className="ml-4 list-disc">
                  {plan.excluded.map(({ reason, count }) => (
                    <li key={reason}>{t(`excluded.${reason}`, { count })}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {plan.waiting === 0 && <p className="text-xs text-muted-foreground">{t("allDecided")}</p>}

        <div role="status" className="text-xs empty:hidden">
          {bulk && <p>{t("bulkRunning", { decision: bulk.decision, done: bulk.done, total: bulk.total })}</p>}
          {report && !bulk && (
            <>
              {report.done > 0 && <p>{t("bulkDone", { decision: report.decision, count: report.done })}</p>}
              {report.failed.length > 0 && (
                <div className="text-destructive-text">
                  <p>{t("bulkFailed", { count: report.failed.length })}</p>
                  <ul className="mt-0.5 space-y-0.5">
                    {report.failed.map(({ toolCallId, error }) => (
                      <li key={toolCallId} className="flex flex-wrap items-baseline gap-1">
                        <button
                          type="button"
                          className="font-medium underline underline-offset-2"
                          onClick={() => go(pageOf(toolCallId) - 1)}
                        >
                          {t("goTo", { page: pageOf(toolCallId) })}
                        </button>
                        <span>
                          —{" "}
                          {error.kind === "stepUpRateLimited"
                            ? tApproval("errors.stepUpRateLimitedNoTime")
                            : tApproval(`errors.${error.kind}`)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {report.skipped > 0 && (
                <p className="text-muted-foreground">{t("bulkSkipped", { count: report.skipped })}</p>
              )}
            </>
          )}
        </div>
      </header>

      {parts.map((part, index) => {
        const id = part.request.toolCallId;
        const tool = tools.get(id);
        const result = tool?.result;
        return (
          <div key={id} hidden={index !== current}>
            <AiApprovalCard
              embedded
              part={part}
              callStatus={tool?.status}
              failureMessage={result?.error?.message}
              onDecide={decideOne}
              locked={bulk !== null}
              busyOverride={
                inFlight[id] ?? (part.outcome === null ? (pager.accepted[id] ?? null) : null)
              }
              externalError={bulkErrors[id] ?? null}
            />
            {result && result.status === "ok" && result.kind !== "read" && (
              <div className="px-3 pb-3">
                <AiEffectChips refs={result.entityRefs} opened={navigated.includes(id)} />
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
