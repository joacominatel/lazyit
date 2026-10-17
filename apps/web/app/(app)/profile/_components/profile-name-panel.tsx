"use client";

import {
  ArrowPathIcon,
  InformationCircleIcon,
  PencilSquareIcon,
} from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import { UpdateOwnProfileSchema, type User } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Controller, type Resolver, useForm } from "react-hook-form";
import { toast } from "sonner";
import { DetailField, DetailPanel } from "@/components/detail-panel";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useUpdateOwnProfile } from "@/lib/api/hooks/use-user-mutations";
import { notifyError } from "@/lib/api/notify-error";
import {
  buildOwnProfilePatch,
  isNameManagedByDirectory,
  ownProfileErrorKind,
} from "@/lib/profile/own-profile";

type NameFormValues = { firstName: string; lastName: string };

/**
 * The shared `PATCH /users/me` contract validates the form (same trim + 1–100 bounds as the API). Its
 * keys are optional on the wire; the form always carries both as strings, so the cast only narrows.
 */
const nameResolver = zodResolver(
  UpdateOwnProfileSchema,
) as unknown as Resolver<NameFormValues>;

/**
 * "Name" panel on `/profile` (issue #1421): the caller edits their OWN first and last name through
 * `PATCH /users/me`. Only the names that changed are sent (`buildOwnProfilePatch`).
 *
 * When the AD/LDAP directory sync owns the person (`directorySource` set, ADR-0091) the API refuses the
 * edit with a 409, because the next sync would overwrite it — so the name is shown read-only with a
 * one-line note instead of a form. A 409 that still arrives (the directory claimed the person after the
 * page loaded) and a service-account 403 each show a clear inline message.
 */
export function ProfileNamePanel({ user }: { user: User }) {
  const t = useTranslations("profile.name");
  const [editing, setEditing] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const update = useUpdateOwnProfile();
  const managed = isNameManagedByDirectory(user);

  const form = useForm<NameFormValues>({
    resolver: nameResolver,
    defaultValues: { firstName: user.firstName, lastName: user.lastName },
  });

  function startEditing() {
    form.reset({ firstName: user.firstName, lastName: user.lastName });
    setInlineError(null);
    setEditing(true);
  }

  const onSubmit = form.handleSubmit((values) => {
    setInlineError(null);
    const patch = buildOwnProfilePatch(user, values);
    if (!patch) {
      setEditing(false);
      return;
    }
    update.mutate(patch, {
      onSuccess: () => {
        toast.success(t("saved"));
        setEditing(false);
      },
      onError: (error) => {
        // The documented refusals read inline; anything unexpected is the standard error toast.
        const kind = ownProfileErrorKind(error);
        if (kind === "generic") {
          notifyError(error, t("errors.generic"));
          return;
        }
        setInlineError(t(`errors.${kind}`));
      },
    });
  });

  const canEdit = !managed && !editing;

  return (
    <DetailPanel
      title={t("title")}
      actions={
        canEdit ? (
          <Button variant="outline" size="sm" onClick={startEditing}>
            <PencilSquareIcon aria-hidden />
            {t("edit")}
          </Button>
        ) : undefined
      }
    >
      {editing ? (
        <form onSubmit={onSubmit} noValidate className="max-w-xl space-y-4">
          <FieldGroup className="grid gap-4 sm:grid-cols-2">
            <Controller
              control={form.control}
              name="firstName"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="profile-first-name">
                    {t("firstName")}
                  </FieldLabel>
                  <Input
                    {...field}
                    id="profile-first-name"
                    autoComplete="given-name"
                    maxLength={100}
                    autoFocus
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  <FieldError
                    errors={
                      fieldState.error ? [{ message: t("fieldInvalid") }] : []
                    }
                  />
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="lastName"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="profile-last-name">
                    {t("lastName")}
                  </FieldLabel>
                  <Input
                    {...field}
                    id="profile-last-name"
                    autoComplete="family-name"
                    maxLength={100}
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  <FieldError
                    errors={
                      fieldState.error ? [{ message: t("fieldInvalid") }] : []
                    }
                  />
                </Field>
              )}
            />
          </FieldGroup>
          {inlineError && (
            <p role="alert" className="text-sm text-destructive">
              {inlineError}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={update.isPending}>
              {update.isPending && <ArrowPathIcon className="animate-spin" />}
              {t("save")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={update.isPending}
              onClick={() => setEditing(false)}
            >
              {t("cancel")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-4">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
            <DetailField label={t("firstName")}>{user.firstName}</DetailField>
            <DetailField label={t("lastName")}>{user.lastName}</DetailField>
          </dl>
          {managed && (
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <InformationCircleIcon
                className="mt-0.5 size-4 shrink-0"
                aria-hidden
              />
              {t("managedByDirectory")}
            </p>
          )}
        </div>
      )}
    </DetailPanel>
  );
}
