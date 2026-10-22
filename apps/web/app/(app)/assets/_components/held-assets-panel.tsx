"use client";

import {
  ArrowPathIcon,
  CheckCircleIcon,
  InboxIcon,
  XCircleIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { type Dispatch, useId, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useAssetsHeldBy } from "@/lib/api/hooks/use-assets";
import { useUserAssignments } from "@/lib/api/hooks/use-users";
import {
  type HeldAssetRow,
  heldAssetRows,
  type ReleaseMarks,
  type ReleaseMarksAction,
  type ReleaseReportItem,
} from "@/lib/assets/assign-with-releases";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";
import { cn } from "@/lib/utils";
import { AssetStatusBadge } from "./asset-status-badge";

/**
 * What the picked person already holds, for the assign step (#1726). `visible` is false until a person
 * is picked, and always false without `user:read`: listing a named person's assignments is
 * directory-relational (#1685), so without it the panel is hidden and assigning works as before — and
 * neither read is sent. `canRelease` mirrors the API's gate on release (`asset:write`, the same as
 * assigning); without it the rows are read-only.
 */
export interface HeldAssets {
  visible: boolean;
  canRelease: boolean;
  rows: HeldAssetRow[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useHeldAssets({
  userId,
  excludeAssetId,
}: {
  userId: string | undefined;
  /** The asset being assigned — never listed as one to release. */
  excludeAssetId?: string;
}): HeldAssets {
  const canReadUsers = useCan("user:read");
  const canRelease = useCan("asset:write");
  const visible = canReadUsers && Boolean(userId);
  const readFor = visible ? userId : undefined;
  // The active assignments are the source of truth for "holds" (and carry the id a release needs); the
  // owner-filtered asset list adds each asset's name, tag, model and status.
  const assignments = useUserAssignments(readFor);
  const assets = useAssetsHeldBy(readFor);
  const rows = useMemo(
    () => heldAssetRows(assignments.data, assets.data?.items, excludeAssetId),
    [assignments.data, assets.data, excludeAssetId],
  );
  return {
    visible,
    canRelease,
    rows,
    isLoading: visible && assignments.isLoading,
    isError: visible && assignments.isError,
    refetch: () => void assignments.refetch(),
  };
}

/**
 * The held-assets panel (#1726): a small working view beside the assign form. It only informs and
 * offers one action per row — mark it to be released. Nothing is sent from here; the caller applies the
 * marks when Assign is pressed. The asset name opens its page in a new tab, so the half-filled assign
 * step is never lost. Rendered by the assign dialog (both entry points) and the new-asset form.
 */
export function HeldAssetsPanel({
  held,
  marks,
  dispatch,
  disabled = false,
  applyOn = "assign",
  className,
}: {
  held: HeldAssets;
  marks: ReleaseMarks;
  dispatch: Dispatch<ReleaseMarksAction>;
  disabled?: boolean;
  /** What applies the marks: the dialog's Assign button, or creating the asset (the new-asset form). */
  applyOn?: "assign" | "create";
  className?: string;
}) {
  const t = useTranslations("assets.assign.held");
  const { date } = useFormatters();
  const headingId = useId();
  const noteId = useId();
  if (!held.visible) return null;

  const { rows, canRelease } = held;
  const { marked, note } = marks;
  const markedCount = rows.filter((row) => marked.includes(row.assignmentId)).length;

  return (
    <section
      aria-labelledby={headingId}
      data-slot="held-assets-panel"
      className={cn("flex min-w-0 flex-col gap-3", className)}
    >
      <div className="space-y-1">
        <h3 id={headingId} className="text-sm font-medium">
          {t("title")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {!canRelease
            ? t("readOnlyDescription")
            : applyOn === "create"
              ? t("descriptionOnCreate")
              : t("description")}
        </p>
      </div>

      {held.isLoading ? (
        <div className="space-y-2" aria-busy="true" aria-label={t("loading")}>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : held.isError ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          <span>{t("error")}</span>
          <Button type="button" variant="outline" size="sm" onClick={held.refetch}>
            <ArrowPathIcon />
            {t("retry")}
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex items-center gap-2 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          <InboxIcon className="size-4 shrink-0" aria-hidden />
          <span>{t("empty")}</span>
        </div>
      ) : (
        <ul className="divide-y rounded-md border md:max-h-80 md:overflow-y-auto">
          {rows.map((row) => {
            const asset = row.asset;
            const name = asset?.name ?? t("assetFallback");
            const isMarked = marked.includes(row.assignmentId);
            const checkboxId = `${headingId}-${row.assignmentId}`;
            const model = asset?.model
              ? `${asset.model.manufacturer} ${asset.model.name}`
              : null;
            return (
              <li
                key={row.assignmentId}
                data-marked={isMarked || undefined}
                className="flex items-start gap-3 px-3 py-2.5 data-[marked]:bg-muted/60"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <a
                      href={`/assets/${row.assetId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn(
                        "truncate font-medium hover:underline",
                        isMarked && "text-muted-foreground line-through",
                      )}
                    >
                      {name}
                      <span className="sr-only"> {t("opensInNewTab")}</span>
                    </a>
                    {asset ? (
                      <AssetStatusBadge status={asset.status} label={asset.statusLabel} />
                    ) : null}
                  </div>
                  <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    {asset?.assetTag ? (
                      <span className="font-mono">{asset.assetTag}</span>
                    ) : null}
                    {model ? <span>{model}</span> : null}
                    <span>{t("since", { date: date(row.assignedAt) })}</span>
                  </p>
                  {isMarked ? (
                    <p className="text-xs font-medium">
                      {applyOn === "create" ? t("willReleaseOnCreate") : t("willRelease")}
                    </p>
                  ) : null}
                </div>
                {canRelease ? (
                  <div className="flex shrink-0 items-center gap-2 pt-0.5">
                    <Checkbox
                      id={checkboxId}
                      checked={isMarked}
                      disabled={disabled}
                      aria-label={t("releaseAria", { name })}
                      onCheckedChange={() =>
                        dispatch({ type: "toggle", assignmentId: row.assignmentId })
                      }
                    />
                    <label
                      htmlFor={checkboxId}
                      className="cursor-pointer text-xs text-muted-foreground select-none"
                    >
                      {t("release")}
                    </label>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {canRelease && markedCount > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium" aria-live="polite">
            {t("markedCount", { count: markedCount })}
          </p>
          <label htmlFor={noteId} className="text-xs text-muted-foreground">
            {t("noteLabel")}
          </label>
          <Textarea
            id={noteId}
            value={note}
            disabled={disabled}
            onChange={(event) => dispatch({ type: "note", note: event.target.value })}
            placeholder={t("notePlaceholder")}
            rows={2}
            maxLength={2000}
          />
          <p className="text-xs text-muted-foreground">{t("noteHelp")}</p>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The per-item report after an assignment whose releases did not all go through (#1726): each held
 * asset the operator marked, released or not, with the reason for a failure. Hook-free, so it renders
 * both inside the assign dialog and as a toast description after the new-asset form navigates away.
 */
export function ReleaseReportList({
  released,
  failed,
  releasedText,
  failedText,
}: {
  released: readonly ReleaseReportItem[];
  failed: readonly ReleaseReportItem[];
  releasedText: string;
  failedText: string;
}) {
  return (
    <ul className="space-y-1.5 text-sm" data-slot="release-report">
      {failed.map((item) => (
        <li key={item.key} className="flex items-start gap-2">
          <XCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <span className="min-w-0">
            <span className="font-medium">{item.label}</span>
            <span className="text-muted-foreground">
              {" — "}
              {failedText}: {item.message}
            </span>
          </span>
        </li>
      ))}
      {released.map((item) => (
        <li key={item.key} className="flex items-start gap-2">
          <CheckCircleIcon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          <span className="min-w-0">
            <span className="font-medium">{item.label}</span>
            <span className="text-muted-foreground">
              {" — "}
              {releasedText}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
