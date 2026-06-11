"use client";

import { ArrowPathIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRetryWorkflowRun } from "@/lib/api/hooks/use-workflow-runs";
import { notifyError } from "@/lib/api/notify-error";
import {
  buildRetryOverrides,
  type RetryOverrideRow,
} from "@/lib/workflow/retry-overrides";

/**
 * The retry-override INSPECTOR dialog (ADR-0057 Option 2). Lets a `workflow:run` holder OPTIONALLY supply
 * a request-scoped field override for the FAILED step before retrying — e.g. add the `lastName` the
 * pinned version's mapping never sent. It shows the failed step's already-mapped field NAMES as context
 * (the redacted projection the run timeline surfaces — issue #347; never their values, INV-6), then lets
 * the operator add/override `field name → value (template or literal)` rows. On submit it calls the
 * existing `POST /workflow-runs/:id/retry` with `{ overrides }`.
 *
 * UX HONESTY (the hard rule of Option 2): the override is REQUEST-SCOPED — applied to the NEXT attempt
 * ONLY and then discarded. It is NOT saved to the workflow definition, NOT stored, and does NOT fix
 * future runs. The dialog says this in plain copy; the plain one-click Retry remains the default elsewhere
 * (this dialog is the opt-in advanced path, never forced).
 */
export function RetryOverrideDialog({
  open,
  onOpenChange,
  runId,
  failedStepKey,
  mappedFields,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runId: string;
  /** The key of the step that failed (shown for context — the retry resumes from it). */
  failedStepKey: string | null;
  /** The NAMES of the fields that step already mapped (redacted; never their values). */
  mappedFields: readonly string[];
}) {
  const t = useTranslations("workflow");
  const tc = useTranslations("common");
  const reactId = useId();
  const retry = useRetryWorkflowRun();

  // One empty row to start — the operator adds the field(s) the pinned mapping missed.
  const [rows, setRows] = useState<RetryOverrideRow[]>([
    { id: `${reactId}-0`, field: "", value: "" },
  ]);
  const [invalid, setInvalid] = useState(false);
  const [seq, setSeq] = useState(1);

  function reset() {
    setRows([{ id: `${reactId}-0`, field: "", value: "" }]);
    setInvalid(false);
    setSeq(1);
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      reset();
    }
    onOpenChange(next);
  }

  function addRow() {
    setRows((current) => [
      ...current,
      { id: `${reactId}-${seq}`, field: "", value: "" },
    ]);
    setSeq((n) => n + 1);
  }

  function removeRow(id: string) {
    setRows((current) =>
      current.length <= 1
        ? [{ id: `${reactId}-0`, field: "", value: "" }]
        : current.filter((row) => row.id !== id),
    );
  }

  function updateRow(id: string, patch: Partial<RetryOverrideRow>) {
    setInvalid(false);
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  }

  /** Prefill an empty row's field name from a context chip (the failed step's mapped field names). */
  function prefillField(name: string) {
    setInvalid(false);
    setRows((current) => {
      const blank = current.find((row) => row.field.trim().length === 0);
      if (blank) {
        return current.map((row) =>
          row.id === blank.id ? { ...row, field: name } : row,
        );
      }
      const nextRow = { id: `${reactId}-${seq}`, field: name, value: "" };
      return [...current, nextRow];
    });
    setSeq((n) => n + 1);
  }

  function submit() {
    const built = buildRetryOverrides(rows);
    if (!built.ok) {
      setInvalid(true);
      return;
    }
    retry.mutate(
      { id: runId, overrides: built.overrides },
      {
        onSuccess: () => {
          toast.success(t("runRetry.overrideToastSuccess"));
          handleOpenChange(false);
        },
        onError: (err) => notifyError(err, t("runRetry.toastError")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("runRetry.overrideTitle")}</DialogTitle>
          <DialogDescription>
            {t("runRetry.overrideDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* The honesty banner — request-scoped, never persisted, not a definition fix. */}
          <p className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
            {t("runRetry.overrideTransientNote")}
          </p>

          {/* Context: the failed step + the field NAMES it already mapped (redacted, INV-6). */}
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              {failedStepKey
                ? t("runRetry.overrideFailedStep", { step: failedStepKey })
                : t("runRetry.overrideNoFailedStep")}
            </p>
            {mappedFields.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {mappedFields.map((field) => (
                  <button
                    key={field}
                    type="button"
                    onClick={() => prefillField(field)}
                    className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    title={t("runRetry.overrideUseField", { field })}
                  >
                    {field}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground/80">
                {t("runRetry.overrideNoMappedFields")}
              </p>
            )}
          </div>

          {/* The editable override rows: field name + value (template or literal). */}
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
              <Label className="text-xs text-muted-foreground">
                {t("runRetry.overrideFieldLabel")}
              </Label>
              <Label className="text-xs text-muted-foreground">
                {t("runRetry.overrideValueLabel")}
              </Label>
              <span className="sr-only">{t("runRetry.overrideRemoveAria")}</span>
            </div>

            {rows.map((row, index) => (
              <div
                key={row.id}
                className="grid grid-cols-[1fr_1fr_auto] items-center gap-2"
              >
                <Input
                  value={row.field}
                  onChange={(e) => updateRow(row.id, { field: e.target.value })}
                  placeholder={t("runRetry.overrideFieldPlaceholder")}
                  aria-label={t("runRetry.overrideFieldAria", {
                    index: index + 1,
                  })}
                  aria-invalid={invalid || undefined}
                  className="font-mono text-xs"
                />
                <Input
                  value={row.value}
                  onChange={(e) => updateRow(row.id, { value: e.target.value })}
                  placeholder={t("runRetry.overrideValuePlaceholder")}
                  aria-label={t("runRetry.overrideValueAria", {
                    index: index + 1,
                  })}
                  aria-invalid={invalid || undefined}
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => removeRow(row.id)}
                  aria-label={t("runRetry.overrideRemoveAria")}
                >
                  <XMarkIcon />
                </Button>
              </div>
            ))}

            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={addRow}
            >
              <PlusIcon />
              {t("runRetry.overrideAddField")}
            </Button>

            {invalid ? (
              <p role="alert" className="text-xs text-destructive">
                {t("runRetry.overrideInvalid")}
              </p>
            ) : null}
          </div>

          <p className="text-xs text-muted-foreground/80">
            {t("runRetry.overrideValueHint")}
          </p>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={retry.isPending}
          >
            {tc("cancel")}
          </Button>
          <Button type="button" onClick={submit} disabled={retry.isPending}>
            <ArrowPathIcon
              className={retry.isPending ? "animate-spin" : undefined}
            />
            {t("runRetry.overrideSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
