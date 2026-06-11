"use client";

import {
  ArrowPathIcon,
  CheckIcon,
  ShieldCheckIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  type SetupAdmin,
  SetupAdminSchema,
  SetupPasswordSchema,
} from "@lazyit/shared";
import { Controller, useForm, useWatch } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { CardContent, CardFooter } from "@/components/ui/card";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useSetupMutation } from "@/lib/api/hooks/use-config-status";

const FORM_ID = "setup-admin-form";

/**
 * Form-only shape when the bundled-Zitadel path requires an initial password. Extends the shared
 * `SetupAdminSchema` with a `password` and a form-local `confirmPassword` — both validated against
 * the shared `SetupPasswordSchema` so the rules and copy stay in lockstep with the API (and apps/web
 * keeps using shared schemas only, never importing `zod` directly). The match check is attached to
 * `confirmPassword` so its error surfaces under that field. `confirmPassword` never leaves the form —
 * only `password` is forwarded to the backend.
 */
const SetupAdminWithPasswordSchema = SetupAdminSchema.extend({
  password: SetupPasswordSchema,
  confirmPassword: SetupPasswordSchema,
}).refine((data) => data.confirmPassword === data.password, {
  message: "Passwords don't match.",
  path: ["confirmPassword"],
});

type AdminFormValues = SetupAdmin & {
  password?: string;
  confirmPassword?: string;
};

/**
 * Live complexity checklist mirroring the bundled-IdP password UX (Zitadel-style grid of
 * requirements with a check/cross per rule). The rule texts are the EXACT messages returned by the
 * shared `SetupPasswordSchema` so the inline checklist and any server-side validation error read the
 * same. The confirmation row is form-local (the schema enforces the match via a refine).
 */
function buildPasswordChecklist(
  password: string,
  confirmPassword: string,
): { label: string; passed: boolean }[] {
  return [
    {
      label: "Must be at least 8 characters long.",
      passed: password.length >= 8,
    },
    {
      label: "Must be less than 70 characters long.",
      passed: password.length > 0 && password.length <= 70,
    },
    {
      label: "Must include an uppercase letter.",
      passed: /[A-Z]/.test(password),
    },
    {
      label: "Must include a lowercase letter.",
      passed: /[a-z]/.test(password),
    },
    { label: "Must include a number.", passed: /[0-9]/.test(password) },
    { label: "Must include a symbol.", passed: /[^A-Za-z0-9]/.test(password) },
    {
      label: "Password confirmation matched.",
      passed: password.length > 0 && password === confirmPassword,
    },
  ];
}

function PasswordChecklist({
  password,
  confirmPassword,
}: {
  password: string;
  confirmPassword: string;
}) {
  const items = buildPasswordChecklist(password, confirmPassword);
  return (
    <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      {items.map((item) => (
        <li
          key={item.label}
          className={cn(
            "flex items-center gap-2 text-xs",
            item.passed ? "text-success" : "text-muted-foreground",
          )}
        >
          {item.passed ? (
            <CheckIcon className="size-4 shrink-0" aria-hidden="true" />
          ) : (
            <XMarkIcon className="size-4 shrink-0 text-destructive" aria-hidden="true" />
          )}
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Step 3 — create the first ADMIN (ADR-0043 §7a step 3). Email + first/last name; the role is FIXED
 * to ADMIN by definition (this endpoint exists only to bootstrap the first administrator), shown as a
 * locked badge rather than an editable control.
 *
 * In bundled-Zitadel mode the server reports `requiresAdminPassword` and the wizard also collects an
 * initial password (set by the backend in Zitadel) with a live complexity checklist; in BYOI the
 * password is neither shown nor sent. The form schema is built dynamically from that flag and
 * validates the password against the shared `SetupPasswordSchema`. The CSRF token (from the status
 * payload) is threaded into the POST; the backend's idempotent gate, CSRF check and rate limit are
 * the real enforcement boundary — surfaced via the parent's onError.
 */
export function StepCreateAdmin({
  csrfToken,
  requiresAdminPassword,
  onBack,
  onCreated,
  onError,
}: {
  csrfToken: string;
  requiresAdminPassword: boolean;
  onBack: () => void;
  onCreated: (email: string, mirrored: boolean) => void;
  onError: (error: unknown) => void;
}) {
  const setup = useSetupMutation();

  const form = useForm<AdminFormValues>({
    resolver: zodResolver(
      requiresAdminPassword ? SetupAdminWithPasswordSchema : SetupAdminSchema,
    ),
    defaultValues: requiresAdminPassword
      ? { email: "", firstName: "", lastName: "", password: "", confirmPassword: "" }
      : { email: "", firstName: "", lastName: "" },
  });

  // Watch the password fields so the complexity checklist updates live as the operator types.
  const passwordValue = useWatch({ control: form.control, name: "password" }) ?? "";
  const confirmPasswordValue =
    useWatch({ control: form.control, name: "confirmPassword" }) ?? "";

  const onSubmit = form.handleSubmit((values) => {
    // `confirmPassword` is form-only; `password` is sent ONLY in the bundled-IdP path. In BYOI we
    // strip both so the wire payload matches the shared `SetupAdmin` shape exactly.
    const data: SetupAdmin = requiresAdminPassword
      ? {
          email: values.email,
          firstName: values.firstName,
          lastName: values.lastName,
          password: values.password,
        }
      : {
          email: values.email,
          firstName: values.firstName,
          lastName: values.lastName,
        };

    setup.mutate(
      { data, csrfToken },
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

            {requiresAdminPassword && (
              <>
                <Controller
                  control={form.control}
                  name="password"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid || undefined}>
                      <FieldLabel htmlFor="password">New password</FieldLabel>
                      <Input
                        {...field}
                        id="password"
                        type="password"
                        value={field.value ?? ""}
                        autoComplete="new-password"
                        placeholder="••••••••"
                        aria-invalid={fieldState.invalid || undefined}
                      />
                    </Field>
                  )}
                />
                <Controller
                  control={form.control}
                  name="confirmPassword"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid || undefined}>
                      <FieldLabel htmlFor="confirmPassword">
                        Confirm password
                      </FieldLabel>
                      <Input
                        {...field}
                        id="confirmPassword"
                        type="password"
                        value={field.value ?? ""}
                        autoComplete="new-password"
                        placeholder="••••••••"
                        aria-invalid={fieldState.invalid || undefined}
                      />
                    </Field>
                  )}
                />
                <PasswordChecklist
                  password={passwordValue}
                  confirmPassword={confirmPasswordValue}
                />
              </>
            )}
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
