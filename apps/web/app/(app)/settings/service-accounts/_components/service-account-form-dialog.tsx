"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import {
  type CreateServiceAccount,
  CreateServiceAccountSchema,
  type Permission,
  type PermissionPillar,
  PERMISSION_META,
  PERMISSIONS,
  type ServiceAccount,
  type UpdateServiceAccount,
  UpdateServiceAccountSchema,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { notifyError } from "@/lib/api/notify-error";
import {
  useCreateServiceAccount,
  useUpdateServiceAccount,
} from "@/lib/api/hooks/use-service-accounts";
import { PermissionPicker } from "./permission-picker";
import { SecretReveal } from "./secret-reveal";

const FORM_ID = "service-account-form";

interface FormState {
  name: string;
  description: string;
  /** A `datetime-local` value (`YYYY-MM-DDTHH:mm`), or "" for no expiry. */
  expiresAt: string;
  isActive: boolean;
  permissions: Set<Permission>;
}

/** Permissions sorted in catalog order for a stable submit/diff shape. */
function sortPermissions(perms: Iterable<Permission>): Permission[] {
  const order = (p: Permission) => PERMISSIONS.indexOf(p);
  return [...new Set(perms)].sort((a, b) => order(a) - order(b));
}

/** ISO-8601 (with TZ) → the local `datetime-local` value the `<input>` expects, or "" if absent. */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // Shift to local time and drop seconds/zone to match the input's `YYYY-MM-DDTHH:mm` format.
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/** A `datetime-local` value → a full ISO-8601 string (UTC), or undefined when empty. */
function localInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function initialState(account?: ServiceAccount): FormState {
  if (account) {
    return {
      name: account.name,
      description: account.description ?? "",
      expiresAt: isoToLocalInput(account.expiresAt),
      isActive: account.isActive,
      permissions: new Set(account.permissions),
    };
  }
  return {
    name: "",
    description: "",
    expiresAt: "",
    isActive: true,
    permissions: new Set(),
  };
}

interface ServiceAccountFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present → edit that account; absent → create a new one. */
  account?: ServiceAccount;
}

/**
 * Create / edit dialog for a service account (ADR-0048). The thin wrapper owns the `<Dialog>`; the body
 * remounts (fresh `useState`) whenever it opens for a different record (or for create), keyed below.
 *
 * On CREATE, a successful submit does NOT close the dialog — it swaps the form for the one-time
 * {@link SecretReveal} panel showing the full token. The secret comes from the mutation RESULT and is
 * never cached. EDIT has no token surface and just closes on success.
 */
export function ServiceAccountFormDialog({
  open,
  onOpenChange,
  account,
}: ServiceAccountFormDialogProps) {
  const recordKey = account ? `edit-${account.id}` : "new";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        {open ? (
          <ServiceAccountForm
            key={recordKey}
            account={account}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ServiceAccountForm({
  account,
  onClose,
}: {
  account?: ServiceAccount;
  onClose: () => void;
}) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const isEdit = account != null;
  const create = useCreateServiceAccount();
  const update = useUpdateServiceAccount();
  const isPending = create.isPending || update.isPending;

  const [values, setValues] = useState<FormState>(() => initialState(account));
  const [error, setError] = useState<string | undefined>(undefined);
  // After a successful CREATE, the once-only token to reveal. Held in local state only — never cached.
  const [secret, setSecret] = useState<{ name: string; token: string } | null>(
    null,
  );

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function togglePermission(permission: Permission, on: boolean) {
    setValues((prev) => {
      const next = new Set(prev.permissions);
      if (on) next.add(permission);
      else next.delete(permission);
      return { ...prev, permissions: next };
    });
  }

  function togglePillar(pillar: PermissionPillar, on: boolean) {
    setValues((prev) => {
      const next = new Set(prev.permissions);
      for (const p of PERMISSIONS) {
        if (PERMISSION_META[p].pillar === pillar) {
          if (on) next.add(p);
          else next.delete(p);
        }
      }
      return { ...prev, permissions: next };
    });
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const name = values.name.trim();
    if (name.length === 0) {
      setError(t("serviceAccounts.form.errors.nameRequired"));
      return;
    }
    if (values.permissions.size === 0) {
      setError(t("serviceAccounts.form.errors.permissionRequired"));
      return;
    }
    const expiresAt = localInputToIso(values.expiresAt);
    const permissions = sortPermissions(values.permissions);
    setError(undefined);

    if (account) {
      const body: UpdateServiceAccount = {
        name,
        description: values.description.trim() || null,
        permissions,
        isActive: values.isActive,
        expiresAt: expiresAt ?? null,
      };
      const parsed = UpdateServiceAccountSchema.safeParse(body);
      if (!parsed.success) {
        setError(t("serviceAccounts.form.errors.invalidFields"));
        return;
      }
      update.mutate(
        { id: account.id, data: parsed.data },
        {
          onSuccess: () => {
            toast.success(t("serviceAccounts.toast.updated"));
            onClose();
          },
          onError: (err) =>
            notifyError(err, t("serviceAccounts.toast.updateError")),
        },
      );
      return;
    }

    const body: CreateServiceAccount = {
      name,
      permissions,
      ...(values.description.trim()
        ? { description: values.description.trim() }
        : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
    const parsed = CreateServiceAccountSchema.safeParse(body);
    if (!parsed.success) {
      setError(t("serviceAccounts.form.errors.invalidFields"));
      return;
    }
    create.mutate(parsed.data, {
      onSuccess: (result) => {
        toast.success(t("serviceAccounts.toast.created"));
        // Swap to the one-time reveal instead of closing — the token is only available now.
        setSecret({ name: result.name, token: result.token });
      },
      onError: (err) =>
        notifyError(err, t("serviceAccounts.toast.createError")),
    });
  }

  // After create: show the once-only secret. Acknowledging closes the whole dialog.
  if (secret) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{t("serviceAccounts.form.secretTitle")}</DialogTitle>
          <DialogDescription>
            {t("serviceAccounts.form.secretDescription")}
          </DialogDescription>
        </DialogHeader>
        <SecretReveal
          name={secret.name}
          token={secret.token}
          action="created"
          onAcknowledge={onClose}
        />
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {isEdit
            ? t("serviceAccounts.form.editTitle")
            : t("serviceAccounts.form.newTitle")}
        </DialogTitle>
        <DialogDescription>
          {isEdit
            ? t("serviceAccounts.form.editDescription")
            : t("serviceAccounts.form.newDescription")}
        </DialogDescription>
      </DialogHeader>

      <form id={FORM_ID} onSubmit={handleSubmit} noValidate>
        <FieldGroup>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="sa-name">
              {t("serviceAccounts.form.nameLabel")}
            </FieldLabel>
            <Input
              id="sa-name"
              value={values.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder={t("serviceAccounts.form.namePlaceholder")}
              maxLength={120}
              aria-invalid={error ? true : undefined}
              autoFocus
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="sa-description">
              {t("serviceAccounts.form.descriptionLabel")}
            </FieldLabel>
            <Textarea
              id="sa-description"
              value={values.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder={t("serviceAccounts.form.descriptionPlaceholder")}
              rows={2}
              maxLength={500}
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="sa-expires">
              {t("serviceAccounts.form.expiresLabel")}
            </FieldLabel>
            <Input
              id="sa-expires"
              type="datetime-local"
              value={values.expiresAt}
              onChange={(e) => set("expiresAt", e.target.value)}
            />
            <FieldDescription>
              {t("serviceAccounts.form.expiresHint")}
            </FieldDescription>
          </Field>

          {isEdit ? (
            <Field orientation="horizontal">
              <div className="space-y-0.5">
                <FieldLabel htmlFor="sa-active">
                  {t("serviceAccounts.form.activeLabel")}
                </FieldLabel>
                <FieldDescription>
                  {t("serviceAccounts.form.activeHint")}
                </FieldDescription>
              </div>
              <Switch
                id="sa-active"
                checked={values.isActive}
                onCheckedChange={(on) => set("isActive", on)}
              />
            </Field>
          ) : null}

          <Field>
            <FieldLabel>{t("serviceAccounts.form.permissionsLabel")}</FieldLabel>
            <FieldDescription>
              {t("serviceAccounts.form.permissionsHint")}
            </FieldDescription>
            <PermissionPicker
              value={values.permissions}
              onToggle={togglePermission}
              onTogglePillar={togglePillar}
              disabled={isPending}
            />
          </Field>

          {error ? <FieldError errors={[{ message: error }]} /> : null}
        </FieldGroup>
      </form>

      <div className="mt-4 flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={isPending}
        >
          {tc("cancel")}
        </Button>
        <Button type="submit" form={FORM_ID} disabled={isPending}>
          {isPending && <ArrowPathIcon className="animate-spin" />}
          {isEdit
            ? t("serviceAccounts.form.saveChanges")
            : t("serviceAccounts.form.createButton")}
        </Button>
      </div>
    </>
  );
}
