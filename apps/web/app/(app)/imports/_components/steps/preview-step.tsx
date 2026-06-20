"use client";

import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import type { ImportDryRunReport, RowResult } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/** How many rows to show before offering "Show all". */
const COLLAPSED_LIMIT = 20;

/** A single count stat in the summary band. */
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

/** One row's outcome line: index + valid/invalid badge + its field-level errors. */
function RowLine({
  row,
  t,
}: {
  row: RowResult;
  t: ReturnType<typeof useTranslations<"imports">>;
}) {
  const invalid = row.status === "invalid";
  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex items-center gap-2 text-sm">
        {invalid ? (
          <ExclamationTriangleIcon className="size-4 shrink-0 text-destructive" aria-hidden="true" />
        ) : (
          <CheckCircleIcon className="size-4 shrink-0 text-success" aria-hidden="true" />
        )}
        <span className="font-medium">
          {t("preview.rowIndex", { index: row.rowIndex })}
        </span>
        <span className={invalid ? "text-destructive" : "text-muted-foreground"}>
          {invalid ? t("preview.rowInvalid") : t("preview.rowValid")}
        </span>
      </div>
      {invalid && row.errors.length > 0 && (
        <ul className="ml-6 space-y-0.5">
          {row.errors.map((error, i) => (
            <li key={i} className="text-xs text-muted-foreground">
              {error.field
                ? t("preview.fieldError", { field: error.field, message: error.message })
                : t("preview.wholeRowError", { message: error.message })}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Step 4 — Dry-run preview (ADR-0069 §5). Renders the report the engine produced WITHOUT writing
 * anything: the at-a-glance counts, the per-row outcomes (with field-level validation errors for the
 * invalid rows), and any explicit asset-tag collisions (a tag in the file already on a live asset —
 * surfaced, never silently dropped, ADR-0069 §7). Conflict RESOLUTION is the next step; this is the
 * read-only review. If zero rows are valid, continuing is blocked with a note to revisit the mapping.
 */
export function PreviewStep({
  report,
  onBack,
  onContinue,
}: {
  report: ImportDryRunReport;
  onBack: () => void;
  onContinue: () => void;
}) {
  const t = useTranslations("imports");
  const [showAll, setShowAll] = useState(false);

  const { counts, rows } = report.result;
  const tagCollisions = report.tags.filter((tag) => tag.collision);
  // Sort invalid rows first so failures surface above the fold.
  const sorted = [...rows].sort((a, b) =>
    a.status === b.status ? a.rowIndex - b.rowIndex : a.status === "invalid" ? -1 : 1,
  );
  const visible = showAll ? sorted : sorted.slice(0, COLLAPSED_LIMIT);
  const hidden = sorted.length - COLLAPSED_LIMIT;
  const noneValid = counts.valid === 0;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("preview.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("preview.description")}</p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label={t("preview.counts.total")} value={counts.total} />
        <Stat label={t("preview.counts.valid")} value={counts.valid} tone="ok" />
        <Stat
          label={t("preview.counts.invalid")}
          value={counts.invalid}
          tone={counts.invalid > 0 ? "bad" : undefined}
        />
      </div>

      {tagCollisions.length > 0 && (
        <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <h3 className="text-sm font-medium text-destructive">
            {t("preview.tagCollisionTitle")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("preview.tagCollisionDescription", { count: tagCollisions.length })}
          </p>
          <ul className="space-y-0.5">
            {tagCollisions.map((tag) => (
              <li key={tag.rowIndex} className="text-xs text-muted-foreground">
                {t("preview.tagCollisionRow", {
                  index: tag.rowIndex,
                  tag: tag.tag ?? "",
                })}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t("preview.rowsTitle")}</h3>
        <ul className="divide-y rounded-lg border px-4">
          {visible.map((row) => (
            <RowLine key={row.rowIndex} row={row} t={t} />
          ))}
        </ul>
        {!showAll && hidden > 0 && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-xs text-primary underline-offset-2 hover:underline"
          >
            {t("preview.showAllRows", { count: sorted.length })}
          </button>
        )}
        {showAll && sorted.length > COLLAPSED_LIMIT && (
          <button
            type="button"
            onClick={() => setShowAll(false)}
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {t("preview.collapseRows")}
          </button>
        )}
      </div>

      {noneValid && (
        <p className="text-sm text-destructive" role="alert">
          {t("preview.allInvalid")}
        </p>
      )}

      <div className="flex justify-between">
        <Button type="button" variant="outline" onClick={onBack}>
          {t("common.back")}
        </Button>
        <Button type="button" onClick={onContinue} disabled={noneValid}>
          {t("preview.continue")}
        </Button>
      </div>
    </div>
  );
}
