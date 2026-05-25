"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import {
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

function toFormValues(user?: User): UserFormValues {
  if (user) {
    return {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      isActive: user.isActive,
    };
  }
  return { email: "", firstName: "", lastName: "" };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

interface UserFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present → edit that user; absent → create a new one. */
  user?: User;
}

/**
 * Create/edit dialog for a User. Unlike Locations (one schema for both modes),
 * the two modes validate against different shared schemas: create uses
 * `CreateUserSchema` (email + names, always active); edit uses `UpdateUserSchema`
 * (adds the `isActive` toggle). The parent remounts this via `key` per mode, so
 * `isEdit` — and therefore the resolver — is fixed for the component's lifetime.
 */
export function UserFormDialog({
  open,
  onOpenChange,
  user,
}: UserFormDialogProps) {
  const isEdit = user != null;
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const isPending = createUser.isPending || updateUser.isPending;

  const form = useForm<UserFormValues>({
    resolver: zodResolver(
      isEdit ? UpdateUserSchema : CreateUserSchema,
    ) as Resolver<UserFormValues>,
    defaultValues: toFormValues(user),
  });

  // Refresh the form whenever it reopens, so a reused dialog never shows stale
  // values from a previous create/edit.
  useEffect(() => {
    if (open) form.reset(toFormValues(user));
  }, [open, user, form]);

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
          onError: (error) =>
            toast.error(errorMessage(error, "Couldn't update user")),
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
          onSuccess: () => {
            toast.success("User created");
            onOpenChange(false);
          },
          onError: (error) =>
            toast.error(errorMessage(error, "Couldn't create user")),
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
