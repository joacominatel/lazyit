"use client";

import { ArrowPathIcon, ShieldCheckIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import { type SetupAdmin, SetupAdminSchema } from "@lazyit/shared";
import { Controller, useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useSetupMutation } from "@/lib/api/hooks/use-config-status";

const FORM_ID = "setup-admin-form";

/**
 * Step 3 — create the first ADMIN (ADR-0043 §7a step 3). Email + first/last name; the role is FIXED
 * to ADMIN by definition (this endpoint exists only to bootstrap the first administrator), shown as a
 * locked badge rather than an editable control. Validates against the shared `SetupAdminSchema`. The
 * CSRF token (from the status payload) is threaded into the POST; the backend's idempotent gate,
 * CSRF check and rate limit are the real enforcement boundary — surfaced via the parent's onError.
 */
export function StepCreateAdmin({
  csrfToken,
  onBack,
  onCreated,
  onError,
}: {
  csrfToken: string;
  onBack: () => void;
  onCreated: (email: string, mirrored: boolean) => void;
  onError: (error: unknown) => void;
}) {
  const setup = useSetupMutation();

  const form = useForm<SetupAdmin>({
    resolver: zodResolver(SetupAdminSchema),
    defaultValues: { email: "", firstName: "", lastName: "" },
  });

  const onSubmit = form.handleSubmit((values) => {
    setup.mutate(
      { data: values, csrfToken },
      {
        onSuccess: (result) => onCreated(result.email, result.mirrored),
        onError,
      },
    );
  });

  return (
    <>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Create the first administrator. This person can manage users, access
          and everything else.
        </p>

        <form id={FORM_ID} onSubmit={onSubmit} noValidate>
          <FieldGroup>
            <Controller
              control={form.control}
              name="firstName"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="firstName">First name</FieldLabel>
                  <Input
                    {...field}
                    id="firstName"
                    value={field.value ?? ""}
                    placeholder="Ada"
                    aria-invalid={fieldState.invalid || undefined}
                    autoFocus
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="lastName"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="lastName">Last name</FieldLabel>
                  <Input
                    {...field}
                    id="lastName"
                    value={field.value ?? ""}
                    placeholder="Lovelace"
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="email"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="email">Email</FieldLabel>
                  <Input
                    {...field}
                    id="email"
                    type="email"
                    value={field.value ?? ""}
                    placeholder="ada@your-org.com"
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
          </FieldGroup>
        </form>

        {/* Role is locked to ADMIN — shown, not editable. */}
        <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <ShieldCheckIcon className="size-4 text-primary" />
          <span className="text-foreground">
            Role: <span className="font-medium">Administrator</span>
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            Locked for the first user
          </span>
        </div>
      </CardContent>
      <CardFooter className="justify-between">
        <Button variant="outline" onClick={onBack} disabled={setup.isPending}>
          Back
        </Button>
        <Button type="submit" form={FORM_ID} disabled={setup.isPending}>
          {setup.isPending && <ArrowPathIcon className="animate-spin" />}
          Create administrator
        </Button>
      </CardFooter>
    </>
  );
}
