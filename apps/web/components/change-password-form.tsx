"use client";

import { ArrowPathIcon, ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ChangePasswordRequestSchema,
  ZitadelPasswordSchema,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useSession } from "next-auth/react";
import { Controller, useForm, useWatch } from "react-hook-form";

import { PasswordStrengthChecklist } from "@/components/password-strength-checklist";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api/client";
import { useChangePassword } from "@/lib/api/hooks/use-password-lifecycle";
import { notifyError } from "@/lib/api/notify-error";
import { setSessionToken } from "@/lib/api/session-token";
import { toast } from "sonner";

/**
 * Form schema (local to the web): the shared change-password contract plus a form-only `confirmPassword`
 * validated against the SAME shared `ZitadelPasswordSchema` the API enforces, so the strength rules and
 * copy never drift (apps/web composes shared schemas — it never imports `zod` directly). Two refines
 * mirror the backend: the confirmation must match, and the new password must differ from the current one
 * (the API also rejects `new===current` — surfaced below if it slips past this client check).
 */
const ChangePasswordFormSchema = ChangePasswordRequestSchema.extend({
  confirmPassword: ZitadelPasswordSchema,
})
  .refine((data) => data.confirmPassword === data.newPassword, {
    message: "Passwords don't match.",
    path: ["confirmPassword"],
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    message: "New password must differ from the current password.",
    path: ["newPassword"],
  });

type ChangePasswordFormValues = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

const FORM_ID = "change-password-form";

/**
 * ChangePasswordForm — the ONE self-service password-rotation form (ADR-0086 §F4b), used by BOTH the
 * profile settings panel (`forced={false}`) and the blocking forced-change wall (`forced={true}`).
 * Fields: current + new + confirm, with a live strength checklist.
 *
 * On success the API returns a FRESH session token minted at the new `sessionEpoch` (the change revoked
 * the old token). We swap it in immediately — `setSessionToken` for the very next client `apiFetch`, and
 * `useSession().update` to persist it into the Auth.js cookie so it survives a reload — so the caller
 * stays logged in instead of being bounced to /login by the global 401 reaction.
 *
 * This mutation opts OUT of the global auth-expiry / forced-change interception (mutation `meta`): a
 * wrong *current* password returns a 401 that must show inline here, NOT sign the user out.
 */
export function ChangePasswordForm({
  forced = false,
  onSuccess,
}: {
  forced?: boolean;
  onSuccess?: () => void;
}) {
  const t = useTranslations("auth.changePassword");
  const { update } = useSession();
  const change = useChangePassword();

  const form = useForm<ChangePasswordFormValues>({
    resolver: zodResolver(ChangePasswordFormSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  const newPasswordValue = useWatch({ control: form.control, name: "newPassword" }) ?? "";
  const confirmPasswordValue =
    useWatch({ control: form.control, name: "confirmPassword" }) ?? "";

  const onSubmit = form.handleSubmit((values) => {
    change.mutate(
      { currentPassword: values.currentPassword, newPassword: values.newPassword },
      {
        onSuccess: async (result) => {
          // Swap to the fresh token BEFORE anything else so no client request races the dead one.
          setSessionToken(result.token);
          // Persist it into the Auth.js session cookie (jwt callback honours a trigger:"update").
          await update({ accessToken: result.token });
          form.reset();
          if (!forced) toast.success(t("success"));
          onSuccess?.();
        },
        onError: (error) => {
          // The API returns a 401 for a WRONG current password — surface it on that field, never as a
          // session sign-out (this mutation is exempt from the global handler). A 400 is the
          // new===current rejection (also caught client-side, but surface the server message if it slips).
          if (error instanceof ApiError && error.status === 401) {
            form.setError("currentPassword", { message: t("currentIncorrect") });
            return;
          }
          if (error instanceof ApiError && error.status === 400) {
            form.setError("newPassword", {
              message: error.message || t("sameAsCurrent"),
            });
            return;
          }
          notifyError(error, t("genericError"));
        },
      },
    );
  });

  return (
    <form id={FORM_ID} onSubmit={onSubmit} noValidate className="space-y-4">
      {forced && (
        <div className="flex gap-3 rounded-lg border border-info/30 bg-info/8 p-3 text-sm">
          <ExclamationTriangleIcon
            className="size-5 shrink-0 text-info"
            aria-hidden="true"
          />
          <p className="text-muted-foreground">{t("forcedIntro")}</p>
        </div>
      )}

      <FieldGroup>
        <Controller
          control={form.control}
          name="currentPassword"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="currentPassword">
                {t("currentLabel")}
              </FieldLabel>
              <Input
                {...field}
                id="currentPassword"
                type="password"
                autoComplete="current-password"
                autoFocus
                aria-invalid={fieldState.invalid || undefined}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="newPassword"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="newPassword">{t("newLabel")}</FieldLabel>
              <Input
                {...field}
                id="newPassword"
                type="password"
                autoComplete="new-password"
                aria-invalid={fieldState.invalid || undefined}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="confirmPassword"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined}>
              <FieldLabel htmlFor="confirmPassword">
                {t("confirmLabel")}
              </FieldLabel>
              <Input
                {...field}
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                aria-invalid={fieldState.invalid || undefined}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <PasswordStrengthChecklist
          password={newPasswordValue}
          confirmPassword={confirmPasswordValue}
        />
      </FieldGroup>

      <Button type="submit" form={FORM_ID} disabled={change.isPending} className="w-full">
        {change.isPending && <ArrowPathIcon className="animate-spin" />}
        {t("submit")}
      </Button>
    </form>
  );
}
