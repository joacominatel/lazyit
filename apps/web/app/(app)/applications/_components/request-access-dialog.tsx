"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { AccessLevelCombobox } from "@/components/access-level-combobox";
import { ApplicationCombobox } from "@/components/application-combobox";
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
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import {
  accessRequestErrorKind,
  buildAccessRequestPayload,
  canFileOnBehalf,
} from "@/lib/access-requests/on-behalf";
import { ApiError } from "@/lib/api/client";
import { useCreateAccessRequest } from "@/lib/api/hooks/use-access-requests";
import { useCurrentUser } from "@/lib/api/hooks/use-users";
import { notifyError } from "@/lib/api/notify-error";
import { useMyPermissions } from "@/lib/hooks/use-permissions";

/**
 * Form values — both optional. `accessLevel` is free-form (each app owns its vocabulary), surfaced via
 * the same combobox the grant dialog uses; `justification` is optional free text. We deliberately do
 * NOT use a zod resolver: the shared `CreateAccessRequestSchema` is a `strictObject`, so validating the
 * wider form object would reject the extra keys — the API stays the authority.
 */
type FormValues = {
  applicationId: string;
  requesterId: string;
  accessLevel?: string;
  justification?: string;
};

const EMPTY_VALUES: FormValues = {
  applicationId: "",
  requesterId: "",
  accessLevel: "",
  justification: "",
};

const FORM_ID = "request-access-form";

interface RequestAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absent → the dialog asks for the application too (the queue's "File a request"). */
  applicationId?: string;
}

/**
 * Request access to an application (ADR-0085) — the self-service counterpart to the admin-only grant
 * dialog. Any role (incl VIEWER) may raise a request for themselves; a caller who can decide requests
 * may also pick another person in "On behalf of" (#1645). On success the request lands in the admin
 * queue. A **409** means that person already has a PENDING request for the app — shown as a friendly
 * "already pending" message, not a raw error.
 */
export function RequestAccessDialog({
  open,
  onOpenChange,
  applicationId,
}: RequestAccessDialogProps) {
  const t = useTranslations("applications");
  const tc = useTranslations("common");
  const request = useCreateAccessRequest();
  const { can } = useMyPermissions();
  const showOnBehalf = canFileOnBehalf(can);
  const { data: me } = useCurrentUser();

  const form = useForm<FormValues>({
    mode: "onTouched",
    defaultValues: EMPTY_VALUES,
  });

  // Reset whenever it reopens, so a reused dialog never shows stale values.
  useEffect(() => {
    if (open) form.reset(EMPTY_VALUES);
  }, [open, form]);

  const onSubmit = form.handleSubmit((values) => {
    const payload = buildAccessRequestPayload(
      {
        ...values,
        applicationId: applicationId ?? values.applicationId,
        requesterId: showOnBehalf ? values.requesterId : undefined,
      },
      me?.id,
    );
    const forSomeoneElse = payload.requesterId !== undefined;
    request.mutate(payload, {
      onSuccess: () => {
        toast.success(
          forSomeoneElse
            ? t("request.submittedOnBehalfToast")
            : t("request.submittedToast"),
        );
        onOpenChange(false);
      },
      onError: (error) => {
        const kind = accessRequestErrorKind(error);
        // A pending request already exists: not a failure, so say so and close.
        if (kind === "alreadyPending") {
          toast.info(
            forSomeoneElse
              ? t("request.alreadyPendingOnBehalf")
              : t("request.alreadyPending"),
          );
          onOpenChange(false);
          return;
        }
        if (kind && error instanceof ApiError) {
          notifyError(
            new ApiError(error.status, t(`request.errors.${kind}`), error.body, error.requestId),
            t("request.error"),
          );
          return;
        }
        notifyError(error, t("request.error"));
      },
    });
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
            {applicationId === undefined && (
              <Controller
                control={form.control}
                name="applicationId"
                rules={{ required: t("request.applicationRequired") }}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel htmlFor="request-application" required>
                      {t("request.applicationLabel")}
                    </FieldLabel>
                    <ApplicationCombobox
                      id="request-application"
                      value={field.value || undefined}
                      onValueChange={field.onChange}
                      ariaInvalid={fieldState.invalid}
                      placeholder={t("request.applicationPlaceholder")}
                      searchPlaceholder={t("request.applicationSearch")}
                      emptyText={t("request.applicationEmpty")}
                    />
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
            )}

            {showOnBehalf && (
              <Controller
                control={form.control}
                name="requesterId"
                render={({ field }) => (
                  <Field>
                    <FieldLabel htmlFor="request-on-behalf">
                      {t("request.onBehalfLabel")}
                    </FieldLabel>
                    <UserCombobox
                      id="request-on-behalf"
                      value={field.value || undefined}
                      onValueChange={field.onChange}
                      accountsOnly
                      placeholder={t("request.onBehalfPlaceholder")}
                      searchPlaceholder={t("request.onBehalfSearch")}
                      emptyText={t("request.onBehalfEmpty")}
                    />
                    <FieldDescription>
                      {t("request.onBehalfDescription")}
                    </FieldDescription>
                  </Field>
                )}
              />
            )}

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
