"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useQueryClient } from "@tanstack/react-query";
import { ArticleStatusSchema, type ArticleStatus } from "@lazyit/shared";
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

/** Accepted upload types — the backend extracts markdown from each (ADR-0021). */
const ACCEPT = ".md,.markdown,.txt,.docx";

interface ImportArticleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Import an article from a `.md` / `.txt` / `.docx` file. The flow is **fully async** (ADR-0053):
 * `POST /articles/import` validates the file synchronously and returns `202 { jobId }`; we then
 * poll `GET /articles/import/:jobId` (~1.5s) until the job reaches a terminal state. On `completed`
 * we resolve the new article's slug and jump to it; on `failed` we surface the job's short, friendly
 * (and permanent) error and let the user pick a different file. The `.docx` parse runs in a
 * sandboxed child server-side, so a decompression bomb can never take down the API (SEC-002).
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

  // jobId (the only stored async state) drives the poll; everything else is derived from it, so we
  // never write state inside an effect — effects only run genuine side effects (toast / navigate).
  const [jobId, setJobId] = useState<string | null>(null);
  // One-shot guards (refs, not state) so the terminal-state effects fire once per job even under
  // React's dev double-invoke and any placeholder-data churn.
  const failedJobRef = useRef<string | null>(null);
  const navigatedJobRef = useRef<string | null>(null);

  const importStatus = useArticleImportStatus(jobId ?? undefined);
  // Ignore stale placeholder data from a previous job (keepPreviousData) by matching the id.
  const jobState =
    importStatus.data?.jobId === jobId ? importStatus.data?.state : undefined;
  const completedArticleId =
    jobState === "completed" ? importStatus.data?.articleId : undefined;
  const failedError = jobState === "failed" ? importStatus.data?.error : undefined;
  // Resolve the new article's slug (the detail route is slug-based) so we can navigate to it.
  const completedArticle = useArticle(completedArticleId);

  // In flight from the POST until we navigate; a permanent failure re-enables the form for retry.
  const isImporting =
    importArticle.isPending || (jobId !== null && jobState !== "failed");

  // Reset everything (in an event handler, never an effect) so a reopened dialog starts clean and
  // any in-flight poll stops being acted on.
  function reset() {
    setFile(null);
    setCategoryId("");
    setStatus("DRAFT");
    setJobId(null);
    failedJobRef.current = null;
    navigatedJobRef.current = null;
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  // A parse/decompression-bomb failure is PERMANENT — surface the job's short, friendly message
  // as-is (never "try again") and let the user pick a different file. Fires once per job.
  useEffect(() => {
    if (jobState !== "failed" || !jobId || failedJobRef.current === jobId) return;
    failedJobRef.current = jobId;
    notifyError(
      failedError ? new Error(failedError) : undefined,
      t("import.toast.importError"),
    );
  }, [jobState, jobId, failedError, t]);

  // Once the completed article resolves, refresh the lists and jump to it. Fires once per job;
  // the push unmounts this dialog, so no explicit close is needed.
  useEffect(() => {
    const article = completedArticle.data;
    if (!article || !jobId || navigatedJobRef.current === jobId) return;
    navigatedJobRef.current = jobId;
    void queryClient.invalidateQueries({ queryKey: articleKeys.all });
    toast.success(t("import.toast.imported"));
    router.push(`/kb/${article.slug}`);
  }, [completedArticle.data, jobId, queryClient, router, t]);

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
          <DialogTitle>{t("import.title")}</DialogTitle>
          <DialogDescription>{t("import.description")}</DialogDescription>
        </DialogHeader>

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

        <DialogFooter>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
