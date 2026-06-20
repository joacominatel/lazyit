"use client";

import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useImportResult } from "@/lib/api/hooks/use-imports";
import { useImportError } from "../use-import-error";

/** A single count stat in the result band. */
function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "bad" }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border px-4 py-3">
      <span
        className={
          tone === "bad"
            ? "text-2xl font-semibold text-destructive"
            : tone === "ok"
              ? "text-2xl font-semibold text-success"
              : "text-2xl font-semibold"
        }
      >
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

/**
 * Step 6 — Commit + result (ADR-0069 §8). The commit was already enqueued by the conflicts step;
 * here we poll the session status (passed down) AND the result ledger until the chunked commit lands
 * its counts. While running, a spinner + a "keep this page open" hint. On COMMITTED we show the
 * append-only ImportRun counts (created / failed / skipped) — KEEP-PARTIAL: a partial import keeps its
 * successful rows and lists the failures (e.g. a value taken since preview). A FAILED session surfaces
 * the PII-free reason. Offers re-import and a jump to the assets list.
 */
export function CommitStep({
  sessionId,
  sessionStatus,
  onImportMore,
}: {
  sessionId: string;
  sessionStatus: string | undefined;
  onImportMore: () => void;
}) {
  const t = useTranslations("imports");
  const { resolve } = useImportError();

  const failed = sessionStatus === "FAILED";
  const committed = sessionStatus === "COMMITTED";
  // Only poll the result endpoint once we're at/after the terminal session state, or while committing.
  const result = useImportResult(sessionId, !failed);
  const counts = result.data?.counts ?? null;
  const ledgerReady = committed && counts != null;

  if (failed) {
    return (
      <div className="space-y-6">
        <div className="flex items-start gap-3" role="alert">
          <ExclamationTriangleIcon className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
          <p className="text-sm text-destructive">{resolve(result.error, "commit")}</p>
        </div>
        <Button type="button" variant="outline" onClick={onImportMore}>
          {t("common.startOver")}
        </Button>
      </div>
    );
  }

  if (!ledgerReady) {
    return (
      <div className="space-y-3">
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <ArrowPathIcon className="size-4 animate-spin" aria-hidden="true" />
          {t("commit.running")}
        </div>
        <p className="text-xs text-muted-foreground">{t("commit.runningHint")}</p>
      </div>
    );
  }

  const hasFailures = counts.failed > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        {hasFailures ? (
          <ExclamationTriangleIcon className="mt-0.5 size-5 shrink-0 text-warning" aria-hidden="true" />
        ) : (
          <CheckCircleIcon className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
        )}
        <div className="space-y-0.5">
          <h2 className="text-base font-semibold">{t("commit.resultTitle")}</h2>
          <p className="text-sm text-muted-foreground">
            {hasFailures ? t("commit.partialNote") : t("commit.allCommitted")}
          </p>
          {result.data?.importRunId != null && (
            <p className="text-xs text-muted-foreground">
              {t("commit.runId", { id: result.data.importRunId })}
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label={t("commit.counts.committed")} value={counts.committed} tone="ok" />
        <Stat
          label={t("commit.counts.failed")}
          value={counts.failed}
          tone={hasFailures ? "bad" : undefined}
        />
        <Stat label={t("commit.counts.skipped")} value={counts.skipped} />
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onImportMore}>
          {t("commit.importMore")}
        </Button>
        <Button asChild>
          <Link href="/assets">{t("commit.viewAssets")}</Link>
        </Button>
      </div>
    </div>
  );
}
