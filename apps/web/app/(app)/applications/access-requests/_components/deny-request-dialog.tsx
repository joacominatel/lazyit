"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
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
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { notifyError } from "@/lib/api/notify-error";

type FormValues = { reason: string };

const FORM_ID = "deny-request-form";

interface DenyRequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Requester name, shown in the prompt for context. */
  requesterName: string;
  /** Deny thunk — typically `(reason) => deny.mutateAsync({ id, data: { reason } })`. */
  onConfirm: (reason: string) => Promise<unknown>;
}

/**
 * Deny an access request (ADR-0085) — a reason is REQUIRED (stored as `deniedReason`, the requester
 * sees it in their profile). Owns the spinner + toasts; stays open on error (e.g. the API's 409 when
 * the request was already decided by someone else) and closes on success.
 */
export function DenyRequestDialog({
  open,
  onOpenChange,
  requesterName,
  onConfirm,
}: DenyRequestDialogProps) {
  const t = useTranslations("applications");
  const tc = useTranslations("common");

  const form = useForm<FormValues>({
    mode: "onTouched",
    defaultValues: { reason: "" },
  });

  useEffect(() => {
    if (open) form.reset({ reason: "" });
  }, [open, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await onConfirm(values.reason.trim());
      toast.success(t("requests.deniedToast"));
      onOpenChange(false);
    } catch (error) {
      notifyError(error, t("requests.decideError"));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("requests.denyTitle")}</DialogTitle>
          <DialogDescription>
            {t("requests.denyDescription", { name: requesterName })}
          </DialogDescription>
        </DialogHeader>

        <form
          id={FORM_ID}
          onSubmit={(e) => {
            e.stopPropagation();
            onSubmit(e);
          }}
          noValidate
        >
          <Controller
            control={form.control}
            name="reason"
            rules={{
              required: t("requests.reasonRequired"),
              validate: (value) =>
                value.trim().length > 0 || t("requests.reasonRequired"),
            }}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="deny-reason" required>
                  {t("requests.reasonLabel")}
                </FieldLabel>
                <Textarea
                  id="deny-reason"
                  name={field.name}
                  ref={field.ref}
                  value={field.value}
                  onBlur={field.onBlur}
                  onChange={(event) => field.onChange(event.target.value)}
                  placeholder={t("requests.reasonPlaceholder")}
                  rows={3}
                  aria-invalid={fieldState.invalid || undefined}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={form.formState.isSubmitting}
          >
            {tc("cancel")}
          </Button>
          <Button
            type="submit"
            form={FORM_ID}
            variant="destructive"
            disabled={form.formState.isSubmitting}
          >
            {form.formState.isSubmitting && (
              <ArrowPathIcon className="animate-spin" />
            )}
            {t("requests.denySubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
