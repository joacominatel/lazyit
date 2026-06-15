"use client";

import { ArrowPathIcon, CheckCircleIcon } from "@heroicons/react/24/outline";
import { useQueryClient } from "@tanstack/react-query";
import { ArticleStatusSchema, type ArticleStatus, type ZipImportResult, type ZipItemResult } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useArticleCategories } from "@/lib/api/hooks/use-article-categories";
import { useImportArticle } from "@/lib/api/hooks/use-article-mutations";
import {
  articleKeys,
  useArticle,
  useArticleImportStatus,
} from "@/lib/api/hooks/use-articles";
import { useCan } from "@/lib/hooks/use-permissions";
import { notifyError } from "@/lib/api/notify-error";

/** Accepted upload types — the backend extracts markdown from each (ADR-0021, ADR-0059 §5). */
const ACCEPT = ".md,.markdown,.txt,.docx,.zip";

/** How many items to show per group before offering "Show all". */
const COLLAPSED_LIMIT = 5;

interface ImportArticleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ---------------------------------------------------------------------------
// Batch result sub-components — rendered only after a completed .zip job.
// ---------------------------------------------------------------------------

/** A single row in the batch result item list. */
function BatchItem({
  item,
  t,
}: {
  item: ZipItemResult;
  t: ReturnType<typeof useTranslations<"kb">>;
}) {
  const label = item.slug ?? item.path;
  const skipReasonKey =
    item.outcome === "skipped" && item.reason
      ? (`import.batch.skipReason.${item.reason}` as Parameters<typeof t>[0])
      : null;
  return (
    <li className="flex flex-col gap-0.5 py-1 text-sm">
      <span className="font-medium text-foreground">{label}</span>
      <span className="text-muted-foreground text-xs">{item.path}</span>
      {item.outcome === "renamed" && item.requestedSlug && (
        <span className="text-muted-foreground text-xs">
          {t("import.batch.originalSlug", { slug: item.requestedSlug })}
        </span>
      )}
      {skipReasonKey && (
        <span className="text-muted-foreground text-xs">
          {String(t(skipReasonKey))}
        </span>
      )}
    </li>
  );
}

/** A collapsible section listing items of a single outcome (created / renamed / skipped). */
function BatchGroup({
  heading,
  items,
  t,
}: {
  heading: string;
  items: ZipItemResult[];
  t: ReturnType<typeof useTranslations<"kb">>;
}) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const visible = expanded ? items : items.slice(0, COLLAPSED_LIMIT);
  const hidden = items.length - COLLAPSED_LIMIT;

  return (
    <section aria-label={heading}>
      <h3 className="text-muted-foreground mb-1 text-xs font-semibold uppercase tracking-wide">
        {heading} ({items.length})
      </h3>
      <ul className="divide-border divide-y" aria-label={heading}>
        {visible.map((item) => (
          <BatchItem key={item.path} item={item} t={t} />
        ))}
      </ul>
      {!expanded && hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-primary mt-1 text-xs underline-offset-2 hover:underline"
        >
          {t("import.batch.showAll", { count: hidden })}
        </button>
      )}
      {expanded && items.length > COLLAPSED_LIMIT && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="text-muted-foreground mt-1 text-xs underline-offset-2 hover:underline"
        >
          {t("import.batch.collapse")}
        </button>
      )}
    </section>
  );
}

/** The complete batch-result panel shown after a .zip import completes. */
function BatchResultPanel({
  batch,
  t,
}: {
  batch: ZipImportResult;
  t: ReturnType<typeof useTranslations<"kb">>;
}) {
  const created = batch.items.filter((i) => i.outcome === "created");
  const renamed = batch.items.filter((i) => i.outcome === "renamed");
  const skipped = batch.items.filter((i) => i.outcome === "skipped");

  return (
    <div className="flex flex-col gap-4" role="region" aria-label={t("import.batch.title")}>
      {/* Summary bar */}
      <div className="flex items-start gap-3">
        <CheckCircleIcon
          className="mt-0.5 size-5 shrink-0 text-success"
          aria-hidden="true"
        />
        <div className="flex-1 space-y-0.5">
          <p className="text-sm font-medium">
            {t("import.batch.summary", {
              created: batch.createdCount,
              renamed: batch.renamedCount,
              skipped: batch.skippedCount,
            })}
          </p>
          <div className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
            {batch.foldersCreated > 0 && (
              <span>
                {t("import.batch.foldersCreated", { count: batch.foldersCreated })}
              </span>
            )}
            {batch.linksResolved > 0 && (
              <span>
                {t("import.batch.linksResolved", { count: batch.linksResolved })}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Per-group item lists — only non-empty groups render */}
      <div className="max-h-64 space-y-4 overflow-y-auto pr-1">
        <BatchGroup heading={t("import.batch.createdHeading")} items={created} t={t} />
        <BatchGroup heading={t("import.batch.renamedHeading")} items={renamed} t={t} />
        {renamed.length > 0 && (
          <p className="text-muted-foreground -mt-2 text-xs">
            {t("import.batch.renamedNote")}
          </p>
        )}
        <BatchGroup heading={t("import.batch.skippedHeading")} items={skipped} t={t} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------

/**
 * Import one or more articles from a file. Accepts .md / .txt / .docx (single-article) and
 * .zip (bulk import, ADR-0059 §5). The flow is fully async (ADR-0053):
 * POST /articles/import validates the file synchronously and returns 202 { jobId }; we then
 * poll GET /articles/import/:jobId (~1.5s) until the job reaches a terminal state.
 *
 * - Single-file (completed + articleId present): resolve the article slug and navigate to it.
 * - Zip (completed + batch present): stay in the dialog; render the per-item batch result panel.
 *   The user reviews and dismisses manually. Navigation is not performed.
 * - Failed (either kind): surface the job error; re-enable the form for retry.
 *
 * The .docx/.zip parse runs in a sandboxed child server-side (SEC-002).
 */
export function ImportArticleDialog({
  open,
  onOpenChange,
}: ImportArticleDialogProps) {
  const t = useTranslations("kb");
  const tc = useTranslations("common");
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: categories } = useArticleCategories();
  const { data: session } = useSession();
  const canWrite = useCan("article:write");
  const importArticle = useImportArticle();

  const [file, setFile] = useState<File | null>(null);
  const [categoryId, setCategoryId] = useState("");
  const [status, setStatus] = useState<ArticleStatus>("DRAFT");

  // jobId (the only stored async state) drives the poll; everything else is derived from it.
  const [jobId, setJobId] = useState<string | null>(null);
  // Batch result for a completed .zip job — surfaces in-dialog for user review.
  const [batchResult, setBatchResult] = useState<ZipImportResult | null>(null);

  // One-shot guards so terminal-state effects fire exactly once per job even under
  // React dev double-invoke and any placeholder-data churn.
  const failedJobRef = useRef<string | null>(null);
  const completedJobRef = useRef<string | null>(null);

  const importStatus = useArticleImportStatus(jobId ?? undefined);
  // Ignore stale placeholder data from a previous job (keepPreviousData) by matching the id.
  const jobState =
    importStatus.data?.jobId === jobId ? importStatus.data?.state : undefined;
  const completedArticleId =
    jobState === "completed" ? importStatus.data?.articleId : undefined;
  const completedBatch =
    jobState === "completed" ? (importStatus.data?.batch ?? null) : undefined;
  const failedError = jobState === "failed" ? importStatus.data?.error : undefined;

  // Resolve the new article slug (detail route is slug-based) — only for single-file imports.
  const completedArticle = useArticle(completedArticleId ?? undefined);

  // In flight from the POST until we navigate (single-file) or the batch panel appears (zip).
  // A permanent failure re-enables the form.
  const isImporting =
    importArticle.isPending ||
    (jobId !== null && jobState !== "failed" && batchResult === null);

  // Reset everything (in an event handler, never an effect) so a reopened dialog starts clean
  // and any in-flight poll stops being acted on.
  function reset() {
    setFile(null);
    setCategoryId("");
    setStatus("DRAFT");
    setJobId(null);
    setBatchResult(null);
    failedJobRef.current = null;
    completedJobRef.current = null;
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  // A parse/decompression-bomb failure is PERMANENT — surface the job short, friendly message
  // as-is (never "try again") and re-enable the form. Fires once per job.
  useEffect(() => {
    if (jobState !== "failed" || !jobId || failedJobRef.current === jobId) return;
    failedJobRef.current = jobId;
    notifyError(
      failedError ? new Error(failedError) : undefined,
      t("import.toast.importError"),
    );
  }, [jobState, jobId, failedError, t]);

  // Single-file completed: refresh lists + jump to the new article. Fires once per job.
  // The router.push unmounts this dialog so no explicit close is needed.
  useEffect(() => {
    const article = completedArticle.data;
    if (
      !article ||
      !jobId ||
      completedJobRef.current === jobId ||
      !completedArticleId // only for single-file — .zip goes through the batch effect below
    )
      return;
    completedJobRef.current = jobId;
    void queryClient.invalidateQueries({ queryKey: articleKeys.all });
    toast.success(t("import.toast.imported"));
    router.push(`/kb/${article.slug}`);
  }, [completedArticle.data, jobId, completedArticleId, queryClient, router, t]);

  // Zip completed: surface the batch result panel in-dialog. Fires once per job.
  useEffect(() => {
    if (!completedBatch || !jobId || completedJobRef.current === jobId) return;
    completedJobRef.current = jobId;
    void queryClient.invalidateQueries({ queryKey: articleKeys.all });
    setBatchResult(completedBatch);
    const total = completedBatch.createdCount + completedBatch.renamedCount;
    toast.success(t("import.toast.batchImported", { count: total }));
  }, [completedBatch, jobId, queryClient, t]);

  function handleImport() {
    if (!session) {
      toast.error(t("import.toast.signInRequired"));
      return;
    }
    if (!file) {
      toast.error(t("import.toast.chooseFile"));
      return;
    }
    if (!categoryId) {
      toast.error(t("import.toast.chooseCategory"));
      return;
    }
    importArticle.mutate(
      { file, fields: { categoryId, status } },
      {
        // Synchronous validation passed and the job is enqueued — start polling.
        onSuccess: ({ jobId: id }) => setJobId(id),
        // Synchronous failures (bad extension / too large) carry an ApiError + request id.
        onError: (error) => notifyError(error, t("import.toast.importError")),
      },
    );
  }

  const hasCategories = (categories?.length ?? 0) > 0;

  // RBAC v2: importing creates an article, so gate on article:write (ADR-0046). Render nothing
  // without it so the dialog never opens; the API still enforces authorship/permission (fails closed).
  if (!canWrite) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {batchResult ? t("import.batch.title") : t("import.title")}
          </DialogTitle>
          {!batchResult && (
            <DialogDescription>{t("import.description")}</DialogDescription>
          )}
        </DialogHeader>

        {/* Batch result panel — replaces the upload form after a .zip job completes */}
        {batchResult ? (
          <BatchResultPanel batch={batchResult} t={t} />
        ) : (
          <>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="import-file">{t("import.fileLabel")}</FieldLabel>
                <Input
                  id="import-file"
                  type="file"
                  accept={ACCEPT}
                  disabled={isImporting}
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
                <FieldDescription>{t("import.fileHint")}</FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="import-category">
                  {t("import.categoryLabel")}
                </FieldLabel>
                <Select
                  value={categoryId}
                  onValueChange={setCategoryId}
                  disabled={isImporting}
                >
                  <SelectTrigger id="import-category" className="w-full">
                    <SelectValue
                      placeholder={
                        hasCategories
                          ? t("import.categorySelect")
                          : t("import.categoryNone")
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {(categories ?? []).map((category) => (
                      <SelectItem key={category.id} value={category.id}>
                        {category.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="import-status">
                  {t("import.statusLabel")}
                </FieldLabel>
                <Select
                  value={status}
                  onValueChange={(value) => setStatus(value as ArticleStatus)}
                  disabled={isImporting}
                >
                  <SelectTrigger id="import-status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ArticleStatusSchema.options.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option === "DRAFT"
                          ? t("status.draft")
                          : t("status.published")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>

            {isImporting && (
              <p
                className="text-muted-foreground flex items-center gap-2 text-sm"
                role="status"
                aria-live="polite"
              >
                <ArrowPathIcon className="size-4 animate-spin" aria-hidden="true" />
                {t("import.processingHint")}
              </p>
            )}
          </>
        )}

        <DialogFooter>
          {batchResult ? (
            <Button type="button" onClick={() => handleOpenChange(false)}>
              {t("import.batch.done")}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => handleOpenChange(false)}
                disabled={isImporting}
              >
                {tc("cancel")}
              </Button>
              <Button
                type="button"
                onClick={handleImport}
                disabled={isImporting || !session}
              >
                {isImporting && <ArrowPathIcon className="animate-spin" />}
                {isImporting ? t("import.importing") : t("import.submit")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
