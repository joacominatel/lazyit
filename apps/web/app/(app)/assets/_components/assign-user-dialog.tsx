"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import { CreateAssetAssignmentSchema } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { Controller, type Resolver, useForm } from "react-hook-form";
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
import { useAssignUser } from "@/lib/api/hooks/use-asset-assignment-mutations";
import { notifyError } from "@/lib/api/notify-error";
import { scrollToFirstError } from "@/lib/utils/scroll-to-error";

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
 */
export function AssignUserDialog({
  open,
  onOpenChange,
  assetId,
  excludeUserIds = [],
}: AssignUserDialogProps) {
  const t = useTranslations("assets.assign");
  const tc = useTranslations("common");
  const assign = useAssignUser();

  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema) as Resolver<FormValues>,
    mode: "onTouched",
    defaultValues: { userId: "", notes: "" },
  });

  // Reset whenever it reopens, so a reused dialog never shows stale values/errors.
  useEffect(() => {
    if (open) form.reset({ userId: "", notes: "" });
  }, [open, form]);

  const onSubmit = form.handleSubmit(
    (values) => {
      const trimmed = values.notes?.trim();
      assign.mutate(
        { assetId, userId: values.userId, ...(trimmed ? { notes: trimmed } : {}) },
        {
          onSuccess: () => {
            toast.success(t("assignedToast"));
            onOpenChange(false);
          },
          onError: (error) => notifyError(error, t("assignError")),
        },
      );
    },
    (_errors, event) => scrollToFirstError(event?.target ?? null),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

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
                    label="user"
                    renderDialog={(dialog) => (
                      <UserFormDialog
                        open={dialog.open}
                        onOpenChange={dialog.onOpenChange}
                        onCreated={(user) => field.onChange(user.id)}
                      />
                    )}
                  >
                    <UserCombobox
                      id="assign-user"
                      value={field.value}
                      onValueChange={field.onChange}
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

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
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
