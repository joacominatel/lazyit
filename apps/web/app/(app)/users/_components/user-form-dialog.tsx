"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  cloneUserDefaults,
  CreateUserSchema,
  type User,
  UpdateUserSchema,
} from "@lazyit/shared";
import { useEffect } from "react";
import { Controller, type Resolver, useForm } from "react-hook-form";
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
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  useCreateUser,
  useUpdateUser,
} from "@/lib/api/hooks/use-user-mutations";
import { notifyError } from "@/lib/api/notify-error";

const FORM_ID = "user-form";

/**
 * Form values. `isActive` is only present (and rendered) in edit mode: a new
 * user is always created active — `CreateUserSchema` doesn't accept the field,
 * deactivation is a PATCH (see the User entity note + ADR-0016).
 */
type UserFormValues = {
  email: string;
  firstName: string;
  lastName: string;
  isActive?: boolean;
};

/**
 * Initial form values. Edit → from `user`. Clone → from the shared `cloneUserDefaults` sanitizer
 * (SECURITY-SENSITIVE: copies ONLY firstName/lastName; email forced "", role OMITTED → server default
 * VIEWER, externalId never set). Otherwise blank. Clone stays in CREATE mode (`user` absent), so the
 * `isActive` toggle never renders and the create submit never carries a role.
 */
function toFormValues(user?: User, cloneSource?: User): UserFormValues {
  if (user) {
    return {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      isActive: user.isActive,
    };
  }
  if (cloneSource) {
    const d = cloneUserDefaults(cloneSource);
    return { email: d.email, firstName: d.firstName, lastName: d.lastName };
  }
  return { email: "", firstName: "", lastName: "" };
}

interface UserFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present → edit that user; absent → create a new one. */
  user?: User;
  /**
   * Present (and `user` absent) → CREATE pre-filled from this record (issue #125). Distinct from the
   * edit `user` prop: the dialog stays in create mode (CreateUserSchema + create mutation), and the
   * shared sanitizer guarantees the privilege-safe reset (no role/externalId, email cleared).
   */
  cloneSource?: User;
  /** Called with the created user (create mode) — lets a caller select it inline (#25). */
  onCreated?: (user: User) => void;
}

/**
 * Create/edit/clone dialog for a User. Unlike Locations (one schema for both modes),
 * the two modes validate against different shared schemas: create uses
 * `CreateUserSchema` (email + names, always active); edit uses `UpdateUserSchema`
 * (adds the `isActive` toggle). The parent remounts this via `key` per mode (edit/clone/create), so
 * `isEdit` — and therefore the resolver — is fixed for the component's lifetime. Clone pre-fills via
 * the privilege-safe `cloneUserDefaults` sanitizer and submits through the normal create flow.
 */
export function UserFormDialog({
  open,
  onOpenChange,
  user,
  cloneSource,
  onCreated,
}: UserFormDialogProps) {
  const isEdit = user != null;
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const isPending = createUser.isPending || updateUser.isPending;

  const form = useForm<UserFormValues>({
    resolver: zodResolver(
      isEdit ? UpdateUserSchema : CreateUserSchema,
    ) as Resolver<UserFormValues>,
    defaultValues: toFormValues(user, cloneSource),
  });

  // Refresh the form whenever it reopens, so a reused dialog never shows stale
  // values from a previous create/edit/clone.
  useEffect(() => {
    if (open) form.reset(toFormValues(user, cloneSource));
  }, [open, user, cloneSource, form]);

  const onSubmit = form.handleSubmit((values) => {
    if (user) {
      updateUser.mutate(
        {
          id: user.id,
          data: {
            email: values.email,
            firstName: values.firstName,
            lastName: values.lastName,
            isActive: values.isActive,
          },
        },
        {
          onSuccess: () => {
            toast.success("User updated");
            onOpenChange(false);
          },
          // The API's own message takes precedence (surfaced verbatim with the request id) — e.g. a
          // duplicate email (409) or an identity-provider write-back failure (503). The fallback only
          // applies if the response carried no message.
          onError: (error) => notifyError(error, "Couldn't update user"),
        },
      );
    } else {
      createUser.mutate(
        {
          email: values.email,
          firstName: values.firstName,
          lastName: values.lastName,
        },
        {
          onSuccess: (created) => {
            onCreated?.(created);
            toast.success("User created");
            onOpenChange(false);
          },
          onError: (error) =>
            notifyError(error, "Couldn't create user"),
        },
      );
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit user" : "New user"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update this person's details."
              : "Add a person to the organization. New users start active."}
          </DialogDescription>
        </DialogHeader>

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
                    placeholder="ada@lazyit.dev"
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  {isEdit && (
                    <FieldDescription>
                      The account-linking key for the identity provider. Must be
                      unique; a change is mirrored to the IdP.
                    </FieldDescription>
                  )}
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />

            {isEdit && (
              <Controller
                control={form.control}
                name="isActive"
                render={({ field }) => (
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor="isActive">Active</FieldLabel>
                      <FieldDescription>
                        Inactive users are kept for history but treated as
                        offboarded — they can no longer be assigned assets.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      id="isActive"
                      checked={field.value ?? false}
                      onCheckedChange={field.onChange}
                    />
                  </Field>
                )}
              />
            )}
          </FieldGroup>
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button type="submit" form={FORM_ID} disabled={isPending}>
            {isPending && <ArrowPathIcon className="animate-spin" />}
            {isEdit ? "Save changes" : "Create user"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
