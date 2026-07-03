"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { AccessLevelCombobox } from "@/components/access-level-combobox";
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
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api/client";
import { useCreateAccessRequest } from "@/lib/api/hooks/use-access-requests";
import { notifyError } from "@/lib/api/notify-error";

/**
 * Form values — both optional. `accessLevel` is free-form (each app owns its vocabulary), surfaced via
 * the same combobox the grant dialog uses; `justification` is optional free text. We deliberately do
 * NOT use a zod resolver: the shared `CreateAccessRequestSchema` is a `strictObject`, so validating the
 * wider form object would reject the extra keys — the API stays the authority.
 */
type FormValues = {
  accessLevel?: string;
  justification?: string;
};

const FORM_ID = "request-access-form";

interface RequestAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: string;
}

/**
 * Request access to an application (ADR-0085) — the self-service counterpart to the admin-only grant
 * dialog. Any role (incl VIEWER) may raise a request; the requester is the authenticated caller, never
 * in the body. On success the request lands in the admin queue and the caller tracks it in their
 * profile. A **409** means a PENDING request for this (caller, app) already exists — shown as a
 * friendly "already pending" message, not a raw error.
 */
export function RequestAccessDialog({
  open,
  onOpenChange,
  applicationId,
}: RequestAccessDialogProps) {
  const t = useTranslations("applications");
  const tc = useTranslations("common");
  const request = useCreateAccessRequest();

  const form = useForm<FormValues>({
    mode: "onTouched",
    defaultValues: { accessLevel: "", justification: "" },
  });

  // Reset whenever it reopens, so a reused dialog never shows stale values.
  useEffect(() => {
    if (open) form.reset({ accessLevel: "", justification: "" });
  }, [open, form]);

  const onSubmit = form.handleSubmit((values) => {
    const level = values.accessLevel?.trim();
    const justification = values.justification?.trim();
    request.mutate(
      {
        applicationId,
        ...(level ? { accessLevel: level } : {}),
        ...(justification ? { justification } : {}),
      },
      {
        onSuccess: () => {
          toast.success(t("request.submittedToast"));
          onOpenChange(false);
        },
        onError: (error) => {
          // 409 = a PENDING request for this (caller, app) already exists. Not a failure — tell the
          // caller they already have one, and close.
          if (error instanceof ApiError && error.status === 409) {
            toast.info(t("request.alreadyPending"));
            onOpenChange(false);
            return;
          }
          notifyError(error, t("request.error"));
        },
      },
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("request.title")}</DialogTitle>
          <DialogDescription>{t("request.description")}</DialogDescription>
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
          <div className="flex flex-col gap-4">
            <Controller
              control={form.control}
              name="accessLevel"
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="request-level">
                    {t("request.accessLevelLabel")}
                  </FieldLabel>
                  <AccessLevelCombobox
                    id="request-level"
                    value={field.value ?? ""}
                    onChange={field.onChange}
                  />
                  <FieldDescription>
                    {t("request.accessLevelDescription")}
                  </FieldDescription>
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="justification"
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="request-justification">
                    {t("request.justificationLabel")}
                  </FieldLabel>
                  <Textarea
                    id="request-justification"
                    name={field.name}
                    ref={field.ref}
                    value={field.value ?? ""}
                    onBlur={field.onBlur}
                    onChange={(event) => field.onChange(event.target.value)}
                    placeholder={t("request.justificationPlaceholder")}
                    rows={3}
                  />
                  <FieldDescription>
                    {t("request.justificationDescription")}
                  </FieldDescription>
                </Field>
              )}
            />
          </div>
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={request.isPending}
          >
            {tc("cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} disabled={request.isPending}>
            {request.isPending && <ArrowPathIcon className="animate-spin" />}
            {t("request.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
