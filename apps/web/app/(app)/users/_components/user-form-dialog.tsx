"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  CreateUserSchema,
  type ManagerFormValue,
  managerDescriptorToFormValue,
  toManagerInput,
  type User,
  UpdateUserSchema,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
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
import { ManagerField } from "./manager-field";
import {
  toResolverInput,
  type UserFormValues,
} from "./user-form-payload";

const FORM_ID = "user-form";

/** A blank manager picker (no manager recorded). */
const EMPTY_MANAGER: ManagerFormValue = { kind: "none" };

/**
 * Initial form values. Edit → from `user` (manager pre-set from the read descriptor; legajo/username from
 * the row). Create → blank. (Cloning a USER is the dedicated server-orchestrated wizard, not this form —
 * ADR-0058 — so there is no `cloneSource` path here.)
 */
function toFormValues(user?: User): UserFormValues {
  if (user) {
    return {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      legajo: user.legajo ?? "",
      username: user.username ?? "",
      manager: managerDescriptorToFormValue(user.manager),
      isActive: user.isActive,
    };
  }
  return {
    email: "",
    firstName: "",
    lastName: "",
    legajo: "",
    username: "",
    manager: EMPTY_MANAGER,
  };
}

interface UserFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present → edit that user; absent → create a new one. */
  user?: User;
  /** Called with the created user (create mode) — lets a caller select it inline (#25). */
  onCreated?: (user: User) => void;
}

/**
 * Create/edit dialog for a User. Unlike Locations (one schema for both modes), the two modes validate
 * against different shared schemas: create uses `CreateUserSchema` (email + names + optional
 * legajo/username/manager, always active); edit uses `UpdateUserSchema` (adds the `isActive` toggle).
 * The parent remounts this via `key` per mode (edit/create), so `isEdit` — and therefore the resolver —
 * is fixed for the component's lifetime. Cloning a user is the dedicated server-orchestrated wizard
 * ({@link CloneUserWizard}), not this form (ADR-0058).
 */
export function UserFormDialog({
  open,
  onOpenChange,
  user,
  onCreated,
}: UserFormDialogProps) {
  const t = useTranslations("users.form");
  const tc = useTranslations("common");
  const isEdit = user != null;
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const isPending = createUser.isPending || updateUser.isPending;

  // The entity schema is the single source of validation truth. We wrap the zodResolver so it sees the
  // wire-shaped payload (manager serialized, empty legajo/username dropped) instead of the loose form
  // values — keeping field-level errors while never duplicating the legajo/username/manager rules. The
  // wire shape and the form shape genuinely differ on `manager` (input union vs. the picker's discriminated
  // value), so the wrapped resolver is cast through `unknown` — the runtime contract is what matters.
  const baseResolver = zodResolver(isEdit ? UpdateUserSchema : CreateUserSchema);
  const resolver: Resolver<UserFormValues> = (values, context, options) =>
    (
      baseResolver as unknown as (
        v: unknown,
        c: unknown,
        o: unknown,
      ) => ReturnType<Resolver<UserFormValues>>
    )(toResolverInput(values), context, options);

  const form = useForm<UserFormValues>({
    resolver,
    defaultValues: toFormValues(user),
  });

  // Refresh the form whenever it reopens, so a reused dialog never shows stale
  // values from a previous create/edit.
  useEffect(() => {
    if (open) form.reset(toFormValues(user));
  }, [open, user, form]);

  const onSubmit = form.handleSubmit((values) => {
    // Shared serialization: empty legajo/username → null (edit, clears) / omitted (create); manager via
    // the XOR builder. Trimming/lowercasing is the shared schema's job (server re-normalizes regardless).
    const legajo = values.legajo.trim();
    const username = values.username.trim();
    const manager = toManagerInput(values.manager);

    if (user) {
      updateUser.mutate(
        {
          id: user.id,
          data: {
            email: values.email,
            firstName: values.firstName,
            lastName: values.lastName,
            isActive: values.isActive,
            // On edit, an empty field CLEARS the value (null), so removing a legajo/username is possible.
            legajo: legajo === "" ? null : legajo,
            username: username === "" ? null : username,
            manager,
          },
        },
        {
          onSuccess: () => {
            toast.success(t("toast.updated"));
            onOpenChange(false);
          },
          // The API's own message takes precedence (surfaced verbatim with the request id) — e.g. a
          // duplicate email (409) or an identity-provider write-back failure (503). The fallback only
          // applies if the response carried no message.
          onError: (error) => notifyError(error, t("toast.updateError")),
        },
      );
    } else {
      createUser.mutate(
        {
          email: values.email,
          firstName: values.firstName,
          lastName: values.lastName,
          // On create, omit the unique optionals when blank so the create can't collide on an empty value.
          ...(legajo !== "" ? { legajo } : {}),
          ...(username !== "" ? { username } : {}),
          // null = "no manager"; a set value is the XOR input union. Always explicit.
          manager,
        },
        {
          onSuccess: (created) => {
            onCreated?.(created);
            toast.success(t("toast.created"));
            onOpenChange(false);
          },
          onError: (error) =>
            notifyError(error, t("toast.createError")),
        },
      );
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t("editTitle") : t("createTitle")}
          </DialogTitle>
          <DialogDescription>
            {isEdit ? t("editDescription") : t("createDescription")}
          </DialogDescription>
        </DialogHeader>

        {/* stopPropagation: this dialog renders in a Radix Portal, but React events bubble through
            the React tree (not the DOM), so when opened inline from another form (e.g. an assign
            dialog's "+ New user") the inner submit would otherwise reach the parent form's onSubmit
            and submit it too (issue #164). */}
        <form
          id={FORM_ID}
          onSubmit={(e) => {
            e.stopPropagation();
            onSubmit(e);
          }}
          noValidate
        >
          <FieldGroup>
            <Controller
              control={form.control}
              name="firstName"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="firstName">{t("firstName")}</FieldLabel>
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
                  <FieldLabel htmlFor="lastName">{t("lastName")}</FieldLabel>
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
                  <FieldLabel htmlFor="email">{t("email")}</FieldLabel>
                  <Input
                    {...field}
                    id="email"
                    type="email"
                    value={field.value ?? ""}
                    placeholder="ada@lazyit.dev"
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  {isEdit && (
                    <FieldDescription>{t("emailHelp")}</FieldDescription>
                  )}
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="legajo"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="legajo">{t("legajo")}</FieldLabel>
                  <Input
                    {...field}
                    id="legajo"
                    value={field.value ?? ""}
                    placeholder={t("legajoPlaceholder")}
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  <FieldDescription>{t("legajoHelp")}</FieldDescription>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="username"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="username">{t("username")}</FieldLabel>
                  <Input
                    {...field}
                    id="username"
                    value={field.value ?? ""}
                    placeholder={t("usernamePlaceholder")}
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  <FieldDescription>{t("usernameHelp")}</FieldDescription>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="manager"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="manager">{t("manager.label")}</FieldLabel>
                  <ManagerField
                    id="manager"
                    value={field.value}
                    onChange={field.onChange}
                    ariaInvalid={fieldState.invalid}
                    excludeUserId={user?.id}
                  />
                  <FieldDescription>{t("manager.help")}</FieldDescription>
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
                      <FieldLabel htmlFor="isActive">{t("active")}</FieldLabel>
                      <FieldDescription>{t("activeHelp")}</FieldDescription>
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
            {tc("cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} disabled={isPending}>
            {isPending && <ArrowPathIcon className="animate-spin" />}
            {isEdit ? t("saveChanges") : t("createUser")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
