"use client";

import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import { ForgotPasswordRequestSchema } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Controller, useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useForgotPassword } from "@/lib/api/hooks/use-password-lifecycle";

type ForgotPasswordFormValues = { identifier: string };

/**
 * Public forgot-password form (ADR-0086 §F4b). Submits an email-or-username to `POST /auth/forgot-
 * password`; the API returns a UNIFORM response whether or not the account exists, so on success we
 * ALWAYS show the same "if that account exists, we've sent a link" confirmation — the UI must not
 * distinguish a match from a miss (no user-enumeration). A network/server failure shows a generic
 * retry error (not an enumeration signal — it reflects transport, not account existence).
 */
export function ForgotPasswordForm() {
  const t = useTranslations("auth.forgotPassword");
  const forgot = useForgotPassword();

  const form = useForm<ForgotPasswordFormValues>({
    resolver: zodResolver(ForgotPasswordRequestSchema),
    defaultValues: { identifier: "" },
  });

  const onSubmit = form.handleSubmit((values) => {
    forgot.mutate(values);
  });

  // Uniform confirmation — shown on success regardless of whether an account matched.
  if (forgot.isSuccess) {
    return (
      <>
        <CardContent className="space-y-4">
          <div className="flex gap-3 rounded-lg border border-success/30 bg-success/8 p-3 text-sm">
            <CheckCircleIcon
              className="size-5 shrink-0 text-success"
              aria-hidden="true"
            />
            <p className="text-foreground">{t("confirmation")}</p>
          </div>
        </CardContent>
        <CardFooter>
          <Button asChild variant="outline" className="w-full">
            <Link href="/login">{t("backToLogin")}</Link>
          </Button>
        </CardFooter>
      </>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t("helper")}</p>

        {forgot.isError && (
          <div
            role="alert"
            className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/8 p-3 text-sm"
          >
            <ExclamationTriangleIcon
              className="size-5 shrink-0 text-destructive"
              aria-hidden="true"
            />
            <p className="text-foreground">{t("genericError")}</p>
          </div>
        )}

        <FieldGroup>
          <Controller
            control={form.control}
            name="identifier"
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="identifier">{t("identifierLabel")}</FieldLabel>
                <Input
                  {...field}
                  id="identifier"
                  type="text"
                  autoComplete="username"
                  autoFocus
                  placeholder={t("identifierPlaceholder")}
                  aria-invalid={fieldState.invalid || undefined}
                />
                <FieldError errors={[fieldState.error]} />
              </Field>
            )}
          />
        </FieldGroup>
      </CardContent>
      <CardFooter className="flex-col gap-2">
        <Button type="submit" className="w-full" disabled={forgot.isPending}>
          {t("submit")}
        </Button>
        <Button asChild variant="ghost" className="w-full">
          <Link href="/login">{t("backToLogin")}</Link>
        </Button>
      </CardFooter>
    </form>
  );
}
