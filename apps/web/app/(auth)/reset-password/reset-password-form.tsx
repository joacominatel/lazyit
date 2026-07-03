"use client";

import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import { ResetPasswordRequestSchema, ZitadelPasswordSchema } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";

import { PasswordStrengthChecklist } from "@/components/password-strength-checklist";
import { Button } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useResetPassword } from "@/lib/api/hooks/use-password-lifecycle";

/**
 * Form schema: the shared reset contract (token + new password) plus a form-only `confirmPassword`
 * validated against the SAME shared `ZitadelPasswordSchema` — one strength policy, no drift (apps/web
 * composes shared schemas, never importing `zod` directly). The token comes from the URL, not the form.
 */
const ResetPasswordFormSchema = ResetPasswordRequestSchema.extend({
  confirmPassword: ZitadelPasswordSchema,
}).refine((data) => data.confirmPassword === data.newPassword, {
  message: "Passwords don't match.",
  path: ["confirmPassword"],
});

type ResetPasswordFormValues = {
  token: string;
  newPassword: string;
  confirmPassword: string;
};

/**
 * Public reset-password form (ADR-0086 §F4b). Submits the token (from the link) + a new password to
 * `POST /auth/reset-password`; the API returns ONE generic error for every invalid/expired/used token
 * (no oracle), surfaced inline. On success it revoked every session, so we route to /login to sign in
 * fresh with the new password.
 */
export function ResetPasswordForm({ token }: { token: string }) {
  const t = useTranslations("auth.resetPassword");
  const router = useRouter();
  const reset = useResetPassword();

  const form = useForm<ResetPasswordFormValues>({
    resolver: zodResolver(ResetPasswordFormSchema),
    defaultValues: { token, newPassword: "", confirmPassword: "" },
  });

  const newPasswordValue = useWatch({ control: form.control, name: "newPassword" }) ?? "";
  const confirmPasswordValue =
    useWatch({ control: form.control, name: "confirmPassword" }) ?? "";

  const onSubmit = form.handleSubmit((values) => {
    reset.mutate(
      { token: values.token, newPassword: values.newPassword },
      {
        onSuccess: () => {
          toast.success(t("success"));
          router.replace("/login");
        },
      },
    );
  });

  return (
    <form onSubmit={onSubmit} noValidate>
      <CardContent className="space-y-4">
        {reset.isError && (
          <div
            role="alert"
            className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/8 p-3 text-sm"
          >
            <ExclamationTriangleIcon
              className="size-5 shrink-0 text-destructive"
              aria-hidden="true"
            />
            <p className="text-foreground">{t("invalidTokenError")}</p>
          </div>
        )}

        <FieldGroup>
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
                  autoFocus
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
      </CardContent>
      <CardFooter>
        <Button type="submit" className="w-full" disabled={reset.isPending}>
          {t("submit")}
        </Button>
      </CardFooter>
    </form>
  );
}
