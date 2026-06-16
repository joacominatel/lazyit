"use client";

import {
  ArrowPathIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import type {
  AssetTagBackfillItem,
  AssetTagBackfillMode,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { AssetModelCombobox } from "@/components/asset-model-combobox";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useAssetTagBackfillApply,
  useAssetTagBackfillPreview,
} from "@/lib/api/hooks/use-asset-tag-scheme";
import { notifyError } from "@/lib/api/notify-error";

const PAGE_SIZE = 20;

/**
 * The asset-tag backfill wizard (ADR-0068 §3/§4, #547) — a `settings:manage` bulk action launched from
 * the {@link AssetTagSchemeEditor} when the scheme is ENABLED. The admin picks a target MODE and an
 * optional AssetModel scope, reviews a paginated, read-only PREVIEW (`currentTag → proposedTag`),
 * deselects any rows they want to leave alone, then APPLIES — re-allocating for real under the
 * skip-existing invariant. Two modes:
 *
 *  - `untagged-only` (default, safe): tag only assets with no tag.
 *  - `normalize-non-conforming` (opt-in, destructive): ALSO re-tag assets whose tag doesn't match the
 *    scheme — behind an explicit warning (it overwrites a human-set, possibly physically-printed tag).
 *
 * Deselection persists ACROSS pagination within the session (a single `Set` of excluded ids), since the
 * preview is server-paged — those ids feed `excludeIds` on apply. The preview writes nothing (the
 * `proposedTag` is indicative); apply re-allocates + re-validates per asset, so any estate drift between
 * preview and apply stays correct. Mounted under the page's `AdminGate`; the API guard is the real gate.
 */
export function AssetTagBackfillDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("settings.assetTagScheme.backfill");

  const [mode, setMode] = useState<AssetTagBackfillMode>("untagged-only");
  const [modelId, setModelId] = useState<string>("");
  const [page, setPage] = useState(0);
  // Deselected ids persist across pages within the session (the preview is server-paged).
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());

  const apply = useAssetTagBackfillApply();

  const { data, isLoading, isFetching, isError, refetch } =
    useAssetTagBackfillPreview({
      mode,
      modelId: modelId || undefined,
      page,
      pageSize: PAGE_SIZE,
      enabled: open,
    });

  const items: AssetTagBackfillItem[] = data?.items ?? [];
  const total = data?.total ?? 0;
  const pageCount = total > 0 ? Math.ceil(total / PAGE_SIZE) : 0;
  const selectedCount = Math.max(total - excludedIds.size, 0);

  // The ids on the CURRENT page (drives the header "select all" tri-state for this page only).
  const pageIds = items.map((item) => item.id);
  const pageSelectedCount = pageIds.filter((id) => !excludedIds.has(id)).length;
  const headerChecked =
    pageIds.length === 0
      ? false
      : pageSelectedCount === 0
        ? false
        : pageSelectedCount === pageIds.length
          ? true
          : "indeterminate";

  function resetScope(next: Partial<{ mode: AssetTagBackfillMode; modelId: string }>) {
    // Any scope change restarts the preview from page 1 and clears the (now-stale) deselection.
    if (next.mode !== undefined) setMode(next.mode);
    if (next.modelId !== undefined) setModelId(next.modelId);
    setPage(0);
    setExcludedIds(new Set());
  }

  function toggleRow(id: string, checked: boolean) {
    setExcludedIds((prev) => {
      const next = new Set(prev);
      // checked = include the row → drop it from the excluded set; unchecked = exclude it.
      if (checked) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePage(checked: boolean) {
    setExcludedIds((prev) => {
      const next = new Set(prev);
      for (const id of pageIds) {
        if (checked) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  function handleApply() {
    apply.mutate(
      { mode, modelId: modelId || undefined, excludeIds: [...excludedIds] },
      {
        onSuccess: (result) => {
          toast.success(
            t("toast.applied", {
              tagged: result.tagged,
              skipped: result.skipped,
            }),
          );
          onOpenChange(false);
        },
        onError: (error) => notifyError(error, t("toast.applyError")),
      },
    );
  }

  // Reset the transient scope when the dialog closes so it reopens clean.
  function handleOpenChange(next: boolean) {
    if (!next) {
      setMode("untagged-only");
      setModelId("");
      setPage(0);
      setExcludedIds(new Set());
    }
    onOpenChange(next);
  }

  const isEmpty = !isLoading && !isError && total === 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Mode toggle */}
          <Field>
            <FieldLabel>{t("mode.label")}</FieldLabel>
            <Tabs
              value={mode}
              onValueChange={(value) =>
                resetScope({ mode: value as AssetTagBackfillMode })
              }
            >
              <TabsList>
                <TabsTrigger value="untagged-only">
                  {t("mode.untaggedOnly")}
                </TabsTrigger>
                <TabsTrigger value="normalize-non-conforming">
                  {t("mode.normalize")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <p className="text-sm text-muted-foreground">
              {mode === "untagged-only"
                ? t("mode.untaggedOnlyHint")
                : t("mode.normalizeHint")}
            </p>
          </Field>

          {/* Destructive-mode warning */}
          {mode === "normalize-non-conforming" ? (
            <Callout
              tone="warning"
              icon={<ExclamationTriangleIcon />}
              role="alert"
            >
              <p className="text-sm font-medium">{t("warning.title")}</p>
              <p className="mt-1 text-sm">{t("warning.body")}</p>
            </Callout>
          ) : null}

          {/* AssetModel filter */}
          <Field>
            <FieldLabel htmlFor="backfill-model">
              {t("modelFilter.label")}
            </FieldLabel>
            <AssetModelCombobox
              id="backfill-model"
              value={modelId}
              onValueChange={(value) => resetScope({ modelId: value })}
              placeholder={t("modelFilter.placeholder")}
            />
          </Field>

          {/* Preview */}
          {isError ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <p className="text-sm font-medium">{t("loadError")}</p>
              <Button variant="outline" onClick={() => refetch()}>
                <ArrowPathIcon
                  className={isFetching ? "animate-spin" : undefined}
                />
                {t("retry")}
              </Button>
            </div>
          ) : isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : isEmpty ? (
            <div className="rounded-lg border border-dashed bg-muted/20 py-8 text-center">
              <p className="text-sm text-muted-foreground">{t("empty")}</p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span aria-live="polite">
                  {t("summary", { selected: selectedCount, total })}
                </span>
              </div>
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={headerChecked}
                          onCheckedChange={(value) => togglePage(value === true)}
                          aria-label={t("table.selectPage")}
                        />
                      </TableHead>
                      <TableHead>{t("table.asset")}</TableHead>
                      <TableHead>{t("table.currentTag")}</TableHead>
                      <TableHead>{t("table.proposedTag")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => {
                      const included = !excludedIds.has(item.id);
                      return (
                        <TableRow
                          key={item.id}
                          data-state={included ? undefined : "selected"}
                        >
                          <TableCell>
                            <Checkbox
                              checked={included}
                              onCheckedChange={(value) =>
                                toggleRow(item.id, value === true)
                              }
                              aria-label={t("table.toggleRow", {
                                name: item.name ?? item.id,
                              })}
                            />
                          </TableCell>
                          <TableCell>
                            <span className="line-clamp-1">
                              {item.name ?? t("table.unnamed")}
                            </span>
                            {item.modelName ? (
                              <span className="block text-xs text-muted-foreground">
                                {item.modelName}
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell>
                            {item.currentTag ? (
                              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                                {item.currentTag}
                              </code>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                {t("table.noTag")}
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <code className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-xs font-semibold">
                              {item.proposedTag}
                            </code>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              {pageCount > 1 ? (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    {t("pagination.page", {
                      page: page + 1,
                      pageCount,
                    })}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page === 0 || isFetching}
                      onClick={() => setPage((prev) => Math.max(prev - 1, 0))}
                    >
                      <ChevronLeftIcon />
                      {t("pagination.previous")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page + 1 >= pageCount || isFetching}
                      onClick={() =>
                        setPage((prev) => Math.min(prev + 1, pageCount - 1))
                      }
                    >
                      {t("pagination.next")}
                      <ChevronRightIcon />
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={apply.isPending}
          >
            {t("cancel")}
          </Button>
          <Button
            onClick={handleApply}
            disabled={apply.isPending || isEmpty || isLoading || selectedCount === 0}
          >
            {apply.isPending && <ArrowPathIcon className="animate-spin" />}
            {t("apply", { count: selectedCount })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
