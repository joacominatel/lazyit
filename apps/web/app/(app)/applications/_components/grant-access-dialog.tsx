"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useEffect, useMemo } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { UserFormDialog } from "@/app/(app)/users/_components/user-form-dialog";
import { AccessLevelCombobox } from "@/components/access-level-combobox";
import { CreatableField } from "@/components/creatable-field";
import { UserCombobox } from "@/components/user-combobox";
import { Badge } from "@/components/ui/badge";
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
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useGrantAccess } from "@/lib/api/hooks/use-access-grant-mutations";
import { useApplicationGrants } from "@/lib/api/hooks/use-applications";
import { notifyError } from "@/lib/api/notify-error";
import { scrollToFirstError } from "@/lib/utils/scroll-to-error";

/** "YYYY-MM-DD" from a date input → ISO datetime (undefined when empty). */
function dateInputToIso(value: string): string | undefined {
  return value ? new Date(`${value}T00:00:00.000Z`).toISOString() : undefined;
}

/**
 * Form values. Only `userId` is required (validated via RHF's field-level `rules` — the value is a
 * real user id picked from the Select, so a `required` check is enough; the API re-validates).
 * `accessLevel` (free-form), `expiresAt` (a `YYYY-MM-DD` date input, not the wire ISO) and `notes`
 * are optional. We deliberately do NOT use a zod resolver here: the shared create schemas are
 * `strictObject`s, so picking one field and validating the wider form object would reject the extra
 * keys as "unrecognized" — the submit then silently fails (no toast, no field error). The API's
 * CreateAccessGrantSchema stays the authority for the cross-field grantedAt≤expiresAt rule.
 */
type FormValues = {
  userId: string;
  accessLevel?: string;
  expiresAt?: string; // YYYY-MM-DD
  notes?: string;
};

const FORM_ID = "grant-access-form";

interface GrantAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: string;
}

/**
 * Grant a user access to an application (opens an AccessGrant). Multi-grant is allowed, so users are
 * not filtered out by existing grants — instead, when the chosen user already holds active grants on
 * this app, the dialog shows that context (their current access levels) so the grantor doesn't
 * duplicate by accident. `accessLevel` is free-form (each app owns its vocabulary) but surfaced via a
 * combobox of the common values; `expiresAt` is informative only (no auto-revoke — ADR-0023). The
 * grantor (`grantedById`) comes from the authenticated user's identity (Bearer token, ADR-0039).
 * Converged onto react-hook-form + zod + the `Field`/`FieldError`/`aria-invalid` contract
 * (validation onTouched; scroll-to-first-error on submit) — public props unchanged.
 */
export function GrantAccessDialog({
  open,
  onOpenChange,
  applicationId,
}: GrantAccessDialogProps) {
  const t = useTranslations("applications");
  const tc = useTranslations("common");
  // The app's current active grants — to show the grantee's existing context (no duplicate by mistake).
  const { data: activeGrants } = useApplicationGrants(applicationId, {
    activeOnly: true,
  });
  const grant = useGrantAccess();

  const form = useForm<FormValues>({
    mode: "onTouched",
    defaultValues: { userId: "", accessLevel: "", expiresAt: "", notes: "" },
  });

  // Reset whenever it reopens, so a reused dialog never shows stale values/errors.
  useEffect(() => {
    if (open) {
      form.reset({ userId: "", accessLevel: "", expiresAt: "", notes: "" });
    }
  }, [open, form]);

  const selectedUserId = useWatch({ control: form.control, name: "userId" });
  // The selected grantee's existing active grants on this application (the "current context").
  const existingForUser = useMemo(
    () => (activeGrants ?? []).filter((g) => g.userId === selectedUserId),
    [activeGrants, selectedUserId],
  );

  const onSubmit = form.handleSubmit(
    (values) => {
      const level = values.accessLevel?.trim();
      const note = values.notes?.trim();
      grant.mutate(
        {
          applicationId,
          userId: values.userId,
          ...(level ? { accessLevel: level } : {}),
          ...(values.expiresAt
            ? { expiresAt: dateInputToIso(values.expiresAt) }
            : {}),
          ...(note ? { notes: note } : {}),
        },
        {
          onSuccess: () => {
            toast.success(t("access.grantedToast"));
            onOpenChange(false);
          },
          onError: (error) => notifyError(error, t("access.grantError")),
        },
      );
    },
    (_errors, event) => scrollToFirstError(event?.target ?? null),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("access.grantTitle")}</DialogTitle>
          <DialogDescription>{t("access.grantDescription")}</DialogDescription>
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
          <FieldGroup>
            <Controller
              control={form.control}
              name="userId"
              rules={{ required: t("access.selectUserError") }}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="grant-user" required>
                    {t("access.userLabel")}
                  </FieldLabel>
                  <CreatableField
                    entityKey="user"
                    renderDialog={(dialog) => (
                      <UserFormDialog
                        open={dialog.open}
                        onOpenChange={dialog.onOpenChange}
                        onCreated={(user) => field.onChange(user.id)}
                      />
                    )}
                  >
                    <UserCombobox
                      id="grant-user"
                      value={field.value}
                      onValueChange={field.onChange}
                      ariaInvalid={fieldState.invalid}
                      placeholder={t("access.selectUser")}
                      searchPlaceholder={t("access.searchUser")}
                      emptyText={t("access.noActiveUsers")}
                    />
                  </CreatableField>
                  {field.value && existingForUser.length > 0 && (
                    <FieldDescription className="flex flex-wrap items-center gap-1.5">
                      <span>{t("access.alreadyHasAccess")}</span>
                      {existingForUser.map((g) => (
                        <Badge key={g.id} variant="secondary">
                          {g.accessLevel ?? t("access.accessFallback")}
                        </Badge>
                      ))}
                    </FieldDescription>
                  )}
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="accessLevel"
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="grant-level">
                    {t("access.accessLevelLabel")}
                  </FieldLabel>
                  <AccessLevelCombobox
                    id="grant-level"
                    value={field.value ?? ""}
                    onChange={field.onChange}
                  />
                  <FieldDescription>
                    {t("access.accessLevelDescription")}
                  </FieldDescription>
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="expiresAt"
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="grant-expires">
                    {t("access.expiresLabel")}
                  </FieldLabel>
                  <Input
                    id="grant-expires"
                    type="date"
                    name={field.name}
                    ref={field.ref}
                    value={field.value ?? ""}
                    onBlur={field.onBlur}
                    onChange={(event) => field.onChange(event.target.value)}
                  />
                  <FieldDescription>
                    {t("access.expiresDescription")}
                  </FieldDescription>
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="notes"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid || undefined}>
                  <FieldLabel htmlFor="grant-notes">
                    {t("access.notesLabel")}
                  </FieldLabel>
                  <Textarea
                    id="grant-notes"
                    name={field.name}
                    ref={field.ref}
                    value={field.value ?? ""}
                    onBlur={field.onBlur}
                    onChange={(event) => field.onChange(event.target.value)}
                    placeholder={t("access.notesPlaceholder")}
                    rows={2}
                    aria-invalid={fieldState.invalid || undefined}
                  />
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
          </FieldGroup>
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={grant.isPending}
          >
            {tc("cancel")}
          </Button>
          <Button type="submit" form={FORM_ID} disabled={grant.isPending}>
            {grant.isPending && <ArrowPathIcon className="animate-spin" />}
            {t("access.grantSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
