"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { DeleteResolution } from "@lazyit/shared";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
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
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CreatedTargetDeleteError,
  isChoiceReady,
  isDeleteResolutionRequired,
  type ResolutionChoice,
  type ResolutionChoiceKind,
  resolutionChoiceKinds,
  retryAfterCreatedTarget,
  runDeleteResolution,
} from "@/lib/api/delete-resolution";
import { notifyError } from "@/lib/api/notify-error";
import { cn } from "@/lib/utils";

type ImpactGroupKey =
  | "assets"
  | "childLocations"
  | "purchaseOrders"
  | "applications"
  | "consumables"
  | "assetModels"
  | "purchaseOrderLines";

/** One kind of affected row; `items` is null when the caller may not read that kind. A null label is an untitled purchase. */
export interface ImpactGroupView {
  key: ImpactGroupKey;
  total: number;
  items: { id: string; label: string | null; href?: string }[] | null;
}


interface TargetPickerProps {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  disabled: boolean;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  /** A target this dialog created, which a cached list may not hold yet. */
  created: { id: string; name: string } | null;
}

interface DeleteResolutionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityKey: "location" | "category" | "model";
  name: string;
  /** Undefined while the delete-impact read is loading. */
  groups: ImpactGroupView[] | undefined;
  impactError: unknown;
  onRetryImpact: () => void;
  /** The move-target picker; it must leave out the row itself (and, for a location, its subtree). */
  renderTargetPicker: (picker: TargetPickerProps) => ReactNode;
  /** The create permission for this kind; without it "create a new one" is not offered. */
  canCreate: boolean;
  createHint: string;
  /** Shown under the impact list, e.g. that some listed rows are informational. */
  impactNote?: string;
  /** The create schema's name limit for this kind. */
  nameMaxLength: number | undefined;
  remove: (resolution?: DeleteResolution) => Promise<unknown>;
  create: (name: string) => Promise<{ id: string; name: string }>;
  onDeleted?: () => void;
}

export function DeleteResolutionDialog({
  open,
  onOpenChange,
  entityKey,
  name,
  groups,
  impactError,
  onRetryImpact,
  renderTargetPicker,
  canCreate,
  createHint,
  impactNote,
  nameMaxLength,
  remove,
  create,
  onDeleted,
}: DeleteResolutionDialogProps) {
  const t = useTranslations("shared");
  const id = useId();
  const [kind, setKind] = useState<ResolutionChoiceKind | null>(null);
  const [targetId, setTargetId] = useState("");
  const [newName, setNewName] = useState("");
  // A target this dialog created; a retry moves to it rather than creating another.
  const [created, setCreated] = useState<{ id: string; name: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const total = groups?.reduce((sum, group) => sum + group.total, 0) ?? 0;
  const needsResolution = groups !== undefined && total > 0;
  const choice: ResolutionChoice | null =
    kind === "detach"
      ? { kind: "detach" }
      : kind === "move"
        ? { kind: "move", targetId }
        : kind === "create"
          ? { kind: "create", name: newName }
          : null;
  const canSubmit =
    groups !== undefined && !isPending && (!needsResolution || isChoiceReady(choice));

  function finish() {
    toast.success(t("dialog.deleted", { entity: entityKey }));
    onOpenChange(false);
    onDeleted?.();
  }

  async function handleDelete() {
    setIsPending(true);
    setFailure(null);
    try {
      if (!needsResolution) {
        await remove(undefined);
      } else if (choice) {
        await runDeleteResolution(choice, { remove, create });
      }
      finish();
    } catch (error) {
      if (error instanceof CreatedTargetDeleteError) {
        const retry = retryAfterCreatedTarget(error.target);
        setCreated(retry.created);
        setKind(retry.kind);
        setTargetId(retry.targetId);
        setFailure(
          t("deleteResolution.createdButNotDeleted", {
            target: error.target.name,
            name,
            error: error.message,
          }),
        );
      } else if (isDeleteResolutionRequired(error)) {
        // Something started pointing at it after the impact read: show the fresh list instead.
        toast.info(t("deleteResolution.changed", { name }));
        onRetryImpact();
      } else {
        notifyError(error, t("dialog.deleteError", { entity: entityKey }));
      }
    } finally {
      setIsPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("dialog.deleteTitle", { entity: entityKey })}</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-medium text-foreground">{name}</span>{" "}
            {impactError
              ? t("deleteResolution.loadError")
              : groups === undefined
                ? t("deleteResolution.loading")
                : needsResolution
                  ? t("deleteResolution.inUse")
                  : t("dialog.deleteDescriptionPrefix")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {impactError ? (
          <div>
            <Button variant="outline" size="sm" onClick={onRetryImpact}>
              <ArrowPathIcon />
              {t("deleteResolution.retry")}
            </Button>
          </div>
        ) : groups === undefined ? (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-56" />
          </div>
        ) : needsResolution ? (
          <div className="space-y-4">
            <ImpactList groups={groups} />
            {impactNote ? <p className="text-sm text-muted-foreground">{impactNote}</p> : null}

            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">
                {t("deleteResolution.choiceLabel")}
              </legend>
              <RadioGroup
                value={kind ?? ""}
                onValueChange={(value) => setKind(value as ResolutionChoiceKind)}
                aria-label={t("deleteResolution.choiceLabel")}
                className="gap-2"
              >
                {resolutionChoiceKinds({ canCreate, created }).map(
                  (option) => (
                    <label
                      key={option}
                      htmlFor={`${id}-${option}`}
                      className={cn(
                        "flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-muted/40",
                        kind === option && "border-primary bg-muted/30",
                      )}
                    >
                      <RadioGroupItem
                        value={option}
                        id={`${id}-${option}`}
                        className="mt-0.5"
                        disabled={isPending}
                      />
                      <span className="space-y-0.5">
                        <span className="block text-sm font-medium">
                          {t(`deleteResolution.${option}`, { entity: entityKey })}
                        </span>
                        {option === "detach" ? (
                          <span className="block text-sm text-muted-foreground">
                            {t("deleteResolution.detachHint", { entity: entityKey })}
                          </span>
                        ) : option === "move" ? (
                          <span className="block text-sm text-muted-foreground">
                            {t("deleteResolution.moveHint", { entity: entityKey })}
                          </span>
                        ) : (
                          <span className="block text-sm text-muted-foreground">{createHint}</span>
                        )}
                      </span>
                    </label>
                  ),
                )}
              </RadioGroup>
            </fieldset>

            {kind === "move" ? (
              <>
                <label htmlFor={`${id}-target`} className="sr-only">
                  {t("deleteResolution.movePlaceholder", { entity: entityKey })}
                </label>
                {renderTargetPicker({
                  id: `${id}-target`,
                  value: targetId,
                  onValueChange: setTargetId,
                  disabled: isPending,
                  placeholder: t("deleteResolution.movePlaceholder", { entity: entityKey }),
                  searchPlaceholder: t("deleteResolution.moveSearch"),
                  emptyText: t("deleteResolution.moveEmpty"),
                  created,
                })}
              </>
            ) : null}
            {kind === "create" ? (
              <Input
                id={`${id}-new-name`}
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder={t("deleteResolution.createLabel")}
                aria-label={t("deleteResolution.createLabel")}
                maxLength={nameMaxLength}
                disabled={isPending}
              />
            ) : null}

            {failure ? (
              <p role="alert" className="text-sm text-destructive">
                {failure}
              </p>
            ) : null}
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{t("dialog.cancel")}</AlertDialogCancel>
          <Button variant="destructive" onClick={handleDelete} disabled={!canSubmit}>
            {isPending && <ArrowPathIcon className="animate-spin" />}
            {needsResolution ? t("deleteResolution.confirm") : t("dialog.delete")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ImpactList({ groups }: { groups: ImpactGroupView[] }) {
  const t = useTranslations("shared.deleteResolution");
  return (
    <div className="max-h-56 space-y-3 overflow-y-auto rounded-lg border p-3">
      {groups
        .filter((group) => group.total > 0)
        .map((group) => {
          const shown = group.items ?? [];
          const more = group.total - shown.length;
          return (
            <section key={group.key} className="space-y-1">
              <h3 className="text-sm font-medium">
                {t(`groups.${group.key}`, { count: group.total })}
              </h3>
              {group.items === null ? (
                <p className="text-sm text-muted-foreground">{t("hidden")}</p>
              ) : (
                <ul className="space-y-0.5 text-sm text-muted-foreground">
                  {shown.map((item) => (
                    <li key={item.id} className="truncate">
                      {item.href ? (
                        <Link href={item.href} className="underline-offset-4 hover:underline">
                          {item.label ?? t("untitledPurchase")}
                        </Link>
                      ) : (
                        (item.label ?? t("untitledPurchase"))
                      )}
                    </li>
                  ))}
                  {more > 0 ? <li>{t("more", { count: more })}</li> : null}
                </ul>
              )}
            </section>
          );
        })}
    </div>
  );
}
