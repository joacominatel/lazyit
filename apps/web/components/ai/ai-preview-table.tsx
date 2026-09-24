"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import { Label } from "@/components/ui/label";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import type { PreviewRecord } from "@/lib/ai/preview";
import {
  buildPreviewTable,
  visibleTableRows,
  type TableCell,
  type TableProblem,
} from "@/lib/ai/preview-table";
import { cn } from "@/lib/utils";
import { ApprovalValue } from "./ai-approval-card";
import { usePreviewFieldLabel } from "./ai-labels";

/**
 * A preview field whose value is a list of records (a batch's rows, #1387), as a table inside the card:
 * a sticky header, its own vertical and horizontal scroll (the page never scrolls sideways), rows that
 * will be skipped visibly marked, a problems column (errors and duplicates, linking to the existing
 * record), and an "only problems" filter. Plain text only; links come from `entityHref`.
 */
export function AiPreviewTable({ field, records }: { field: string; records: PreviewRecord[] }) {
  const t = useTranslations("ai.approval.table");
  const tRoot = useTranslations();
  const fieldLabel = usePreviewFieldLabel();
  const switchId = useId();
  const captionId = useId();
  const table = useMemo(() => buildPreviewTable(records), [records]);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const rows = visibleTableRows(table, onlyProblems && table.problemCount > 0);

  /** A status enum value reads with the asset status label when the catalog has one. */
  function statusText(cell: TableCell): string | null {
    if (cell.value.kind !== "text") return null;
    const key = `assets.status.${cell.value.text}`;
    return /^[A-Z_]+$/.test(cell.value.text) && tRoot.has(key) ? tRoot(key) : null;
  }

  function renderCell(column: string, cell: TableCell) {
    const status = column === "status" ? statusText(cell) : null;
    const content = status !== null ? <span>{status}</span> : <ApprovalValue value={cell.value} />;
    return (
      <>
        {cell.href && cell.value.kind === "text" ? (
          <Link href={cell.href} className="text-primary underline-offset-2 hover:underline">
            {cell.value.text}
          </Link>
        ) : (
          content
        )}
        {cell.defaulted && <span className="ml-1 text-muted-foreground">({t("defaulted")})</span>}
      </>
    );
  }

  function renderProblem(problem: TableProblem) {
    switch (problem.kind) {
      case "error":
        return problem.text;
      case "duplicateRow":
        return t("duplicateRow", { field: fieldLabel(problem.field), value: problem.value, row: problem.row });
      case "duplicateExisting":
        return (
          <>
            {t("duplicateExisting", { field: fieldLabel(problem.field), value: problem.value })}{" "}
            {problem.href ? (
              <Link href={problem.href} className="text-primary underline-offset-2 hover:underline">
                {problem.label}
              </Link>
            ) : (
              <span className="font-medium">{problem.label}</span>
            )}
          </>
        );
    }
  }

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p id={captionId} className="text-xs font-medium">
          {fieldLabel(field)}{" "}
          <span className="font-normal text-muted-foreground">
            {t("showing", { shown: rows.length, total: table.rows.length })}
          </span>
        </p>
        {table.problemCount > 0 && (
          <div className="flex items-center gap-1.5">
            <Switch id={switchId} size="sm" checked={onlyProblems} onCheckedChange={setOnlyProblems} />
            <Label htmlFor={switchId} className="text-xs font-normal">
              {t("onlyProblems", { count: table.problemCount })}
            </Label>
          </div>
        )}
      </div>
      <div
        role="region"
        aria-labelledby={captionId}
        // Focusable so keyboard users can scroll the region (WCAG 2.1.1).
        tabIndex={0}
        className="max-h-80 max-w-full overflow-auto rounded-sm border border-border focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <table className="w-max min-w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-muted text-left text-muted-foreground">
            <tr>
              <th scope="col" className="px-2 py-1.5 font-medium">
                {t("rowNumber")}
              </th>
              {table.columns.map((column) => (
                <th key={column} scope="col" className="px-2 py-1.5 font-medium whitespace-nowrap">
                  {fieldLabel(column)}
                </th>
              ))}
              <th scope="col" className="px-2 py-1.5 font-medium">
                {t("problems")}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr
                key={row.number}
                className={cn("align-top", !row.applied && "bg-muted/60 text-muted-foreground")}
              >
                <th scope="row" className="px-2 py-1.5 text-left font-mono font-normal tabular-nums">
                  <span className="flex flex-col items-start gap-1">
                    {row.number}
                    {!row.applied && <StatusBadge tone="neutral">{t("willBeSkipped")}</StatusBadge>}
                  </span>
                </th>
                {table.columns.map((column) => (
                  <td key={column} className="max-w-64 px-2 py-1.5 break-words">
                    {renderCell(column, row.cells[column]!)}
                  </td>
                ))}
                <td className="max-w-80 min-w-48 px-2 py-1.5">
                  {row.problems.length === 0 ? (
                    <span className="text-muted-foreground">{t("noProblems")}</span>
                  ) : (
                    <ul className="space-y-0.5 text-destructive-text">
                      {row.problems.map((problem, index) => (
                        <li key={index} className="break-words">
                          {renderProblem(problem)}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
