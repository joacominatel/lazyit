"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import { CreateAssetAssignmentSchema } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useEffect, useReducer, useState } from "react";
import { Controller, type Resolver, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { UserFormDialog } from "@/app/(app)/users/_components/user-form-dialog";
import { CreatableField } from "@/components/creatable-field";
import { UserCombobox } from "@/components/user-combobox";
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
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { useAssignWithReleases } from "@/lib/api/hooks/use-asset-assignment-mutations";
import { notifyError } from "@/lib/api/notify-error";
import {
  markedRows,
  NO_RELEASE_MARKS,
  releaseMarksReducer,
  type ReleaseReportItem,
  releaseReport,
} from "@/lib/assets/assign-with-releases";
import { cn } from "@/lib/utils";
import { scrollToFirstError } from "@/lib/utils/scroll-to-error";
import {
  HeldAssetsPanel,
  ReleaseReportList,
  useHeldAssets,
} from "./held-assets-panel";

/**
 * Form schema — `assetId` is supplied by the prop, so only the user choice + notes are validated.
 * Picked off the shared create schema (so the `userId`/`notes` constraints stay in one place).
 */
const FormSchema = CreateAssetAssignmentSchema.pick({
  userId: true,
  notes: true,
});
type FormValues = { userId: string; notes?: string };

const FORM_ID = "assign-user-form";

interface AssignUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetId: string;
  /** Users already actively assigned to this asset — hidden from the select. */
  excludeUserIds?: string[];
}

/**
 * Assign a user to an asset (opens an AssetAssignment). Only active users who aren't already current
 * owners are selectable. Notes are optional. Author of the assignment (`assignedById`) comes from
 * the authenticated caller (ADR-0039). Converged onto react-hook-form + zod + the
 * `Field`/`FieldError`/`aria-invalid` contract (validation onTouched; scroll-to-first-error on
 * submit) — public props unchanged.
 *
 * The swap step (#1726): once a person is picked, a panel on the right lists what they already hold
 * ({@link HeldAssetsPanel}; hidden without `user:read`, read-only without `asset:write`). Marked
 * releases are applied only when Assign is pressed — the new assignment first, then each release —
 * and Cancel (or any other close) drops the marks without sending anything. If some releases fail,
 * the dialog stays open on a per-item report instead of closing. Used by the asset detail page and
 * the assets list row action.
 */
export function AssignUserDialog({
  open,
  onOpenChange,
  assetId,
  excludeUserIds = [],
}: AssignUserDialogProps) {
  const t = useTranslations("assets.assign");
  const tc = useTranslations("common");
  const assign = useAssignWithReleases();
  // Held assets marked for release, and the one optional release note shared by all of them. Cleared
  // on every close and whenever the person changes — a mark only ever applies to the person shown.
  const [marks, dispatchMarks] = useReducer(releaseMarksReducer, NO_RELEASE_MARKS);
  // The per-item report when the assignment landed but a release did not.
  const [report, setReport] = useState<{
    released: ReleaseReportItem[];
    failed: ReleaseReportItem[];
  } | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema) as Resolver<FormValues>,
    mode: "onTouched",
    defaultValues: { userId: "", notes: "" },
  });

  // Reset whenever it reopens, so a reused dialog never shows stale values/errors.
  useEffect(() => {
    if (open) form.reset({ userId: "", notes: "" });
  }, [open, form]);

  const userId = useWatch({ control: form.control, name: "userId" });
  const held = useHeldAssets({ userId: userId || undefined, excludeAssetId: assetId });

  // Every close path (Cancel, the X, Escape, the overlay, Done) lands here: nothing marked is sent.
  // While the assignment and its releases run, the dialog stays open so their outcome lands in it.
  function handleOpenChange(next: boolean) {
    if (!next && assign.isPending) return;
    if (!next) {
      dispatchMarks({ type: "close" });
      setReport(null);
    }
    onOpenChange(next);
  }

  function pickUser(id: string, onChange: (id: string) => void) {
    if (id !== userId) dispatchMarks({ type: "pick" });
    onChange(id);
  }

  const onSubmit = form.handleSubmit(
    async (values) => {
      const trimmed = values.notes?.trim();
      // Only marks that still name a listed row, and only when the caller may release them.
      const releases =
        held.visible && held.canRelease ? markedRows(held.rows, marks.marked) : [];
      const outcome = await assign.mutateAsync({
        assignment: {
          assetId,
          userId: values.userId,
          ...(trimmed ? { notes: trimmed } : {}),
        },
        releases,
        note: marks.note,
      });
      if (outcome.kind === "assign-failed") {
        // Nothing was released; the marks stay so the operator can retry.
        notifyError(outcome.error, t("assignError"));
        return;
      }
      if (outcome.failed.length > 0) {
        setReport(
          releaseReport(outcome, releases, t("held.assetFallback"), t("report.failedFallback")),
        );
        return;
      }
      toast.success(
        outcome.released.length > 0
          ? t("assignedAndReleasedToast", { count: outcome.released.length })
          : t("assignedToast"),
      );
      handleOpenChange(false);
    },
    (_errors, event) => scrollToFirstError(event?.target ?? null),
  );

  if (report) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("report.title")}</DialogTitle>
            <DialogDescription>{t("report.description")}</DialogDescription>
          </DialogHeader>
          <ReleaseReportList
            released={report.released}
            failed={report.failed}
            releasedText={t("report.released")}
            failedText={t("report.failed")}
          />
          <DialogFooter>
            <Button type="button" onClick={() => handleOpenChange(false)}>
              {t("report.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* Two columns once a person is picked and the caller may list their assets: the form on the
          left, what they hold on the right; on narrow screens the panel stacks below the form. */}
      <DialogContent className={cn(held.visible ? "sm:max-w-3xl" : "sm:max-w-md")}>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className={cn(held.visible && "grid gap-4 md:grid-cols-2 md:gap-6")}>
          {/* stopPropagation: a form inside a Radix Portal still bubbles its submit through the React
              tree to any ancestor form, so guard it defensively (issue #164). */}
          <form
            id={FORM_ID}
            onSubmit={(e) => {
              e.stopPropagation();
              onSubmit(e);
            }}
            noValidate
          >
            <FieldGroup>
              <Controller
                control={form.control}
                name="userId"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel htmlFor="assign-user" required>
                      {t("user")}
                    </FieldLabel>
                    <CreatableField
                      entityKey="user"
                      renderDialog={(dialog) => (
                        <UserFormDialog
                          open={dialog.open}
                          onOpenChange={dialog.onOpenChange}
                          onCreated={(user) => pickUser(user.id, field.onChange)}
                        />
                      )}
                    >
                      <UserCombobox
                        id="assign-user"
                        value={field.value}
                        onValueChange={(id) => pickUser(id, field.onChange)}
                        excludeUserIds={excludeUserIds}
                        ariaInvalid={fieldState.invalid}
                        placeholder={t("selectUser")}
                        searchPlaceholder={t("searchUser")}
                        emptyText={t("noAssignableUsers")}
                      />
                    </CreatableField>
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />

              <Controller
                control={form.control}
                name="notes"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel htmlFor="assign-notes">{t("notes")}</FieldLabel>
                    <Textarea
                      id="assign-notes"
                      name={field.name}
                      ref={field.ref}
                      value={field.value ?? ""}
                      onBlur={field.onBlur}
                      onChange={(event) => field.onChange(event.target.value)}
                      placeholder={t("notesPlaceholder")}
                      rows={2}
                      aria-invalid={fieldState.invalid || undefined}
                    />
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
            </FieldGroup>
          </form>

          <HeldAssetsPanel
            held={held}
            marks={marks}
            dispatch={dispatchMarks}
            disabled={assign.isPending}
            className="border-t pt-4 md:border-t-0 md:border-l md:pt-0 md:pl-6"
          />
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={assign.isPending}
          >
            {tc("cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} disabled={assign.isPending}>
            {assign.isPending && <ArrowPathIcon className="animate-spin" />}
            {t("assign")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
