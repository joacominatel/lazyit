"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { AssetStatusLabel } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { useAssetStatusLabel } from "@/app/(app)/assets/_components/asset-status-badge";
import {
  groupStatusOptions,
  labelOfChoice,
  type StatusChoice,
} from "@/app/(app)/assets/_components/asset-status-options";
import { AssetStatusSelect } from "@/app/(app)/assets/_components/asset-status-picker";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import type { AssetStatusLabelReassign } from "@/lib/api/endpoints/asset-status-labels";
import { useDeleteAssetStatusLabel } from "@/lib/api/hooks/use-asset-status-labels";
import { notifyError } from "@/lib/api/notify-error";

/** The DELETE target of a destination choice: a custom status by id, or a bare built-in status. */
export function reassignTargetOf(choice: StatusChoice): AssetStatusLabelReassign {
  return choice.labelId
    ? { reassignLabelId: choice.labelId }
    : { reassignStatus: choice.status };
}

/**
 * Archive a custom status (ADR-0101). When live assets carry it, the operator must say WHERE they go —
 * another live custom status or a bare built-in status (grouped like every status picker) — and sees how
 * many move; the move, its history and the archive happen in one API transaction. Nothing is preselected:
 * moving assets is a deliberate choice.
 *
 * An unused one (no live asset) is a plain confirm. It still sends its own built-in status as the
 * destination: `assetCount` counts live assets only, and an ARCHIVED asset that still carries it must go
 * somewhere too (the API requires a target for any carrier) — keeping its built-in status and dropping the
 * custom name is the move that changes the least.
 */
export function AssetStatusLabelArchiveDialog({
  label,
  liveLabels,
  onOpenChange,
}: {
  label: AssetStatusLabel;
  /** Every live custom status (the destinations are these minus `label`). */
  liveLabels: readonly AssetStatusLabel[];
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("settings.taxonomies.statuses.archive");
  const tc = useTranslations("common");
  const statusLabel = useAssetStatusLabel();
  const remove = useDeleteAssetStatusLabel();
  const count = label.assetCount ?? 0;
  const inUse = count > 0;
  const groups = groupStatusOptions(liveLabels.filter((other) => other.id !== label.id));
  const [destination, setDestination] = useState<StatusChoice | null>(null);
  const destinationName = destination
    ? (labelOfChoice(destination, groups)?.name ?? statusLabel(destination.status))
    : null;

  function handleConfirm() {
    const target: AssetStatusLabelReassign = inUse
      ? reassignTargetOf(destination as StatusChoice)
      : { reassignStatus: label.kind };
    remove.mutate(
      { id: label.id, target },
      {
        onSuccess: (result) => {
          toast.success(
            result.movedAssetCount > 0 && destinationName
              ? t("toastMoved", {
                  name: label.name,
                  count: result.movedAssetCount,
                  target: destinationName,
                })
              : t("toast", { name: label.name }),
          );
          onOpenChange(false);
        },
        onError: (err) => notifyError(err, t("error")),
      },
    );
  }

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && !remove.isPending) onOpenChange(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title", { name: label.name })}</AlertDialogTitle>
          <AlertDialogDescription>
            {inUse ? t("inUseDescription", { count }) : t("unusedDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {inUse ? (
          <Field>
            <FieldLabel htmlFor="status-label-destination">{t("destinationLabel")}</FieldLabel>
            <AssetStatusSelect
              id="status-label-destination"
              value={destination}
              onChange={setDestination}
              groups={groups}
              placeholder={t("destinationPlaceholder")}
            />
            <FieldDescription>
              {destinationName
                ? t("destinationSummary", { count, target: destinationName })
                : t("destinationHelp")}
            </FieldDescription>
          </Field>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>{tc("cancel")}</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={remove.isPending || (inUse && destination === null)}
          >
            {remove.isPending && <ArrowPathIcon className="animate-spin" />}
            {inUse ? t("confirmMove") : t("confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
