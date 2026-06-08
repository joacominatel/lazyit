"use client";

import { ArrowPathIcon, LockClosedIcon } from "@heroicons/react/24/outline";
import type { WorkflowSecret } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { notifyError } from "@/lib/api/notify-error";
import { useUpdateWorkflowConnection } from "@/lib/api/hooks/use-workflow-connections";
import {
  useCreateWorkflowSecret,
  useDeleteWorkflowSecret,
  useRotateWorkflowSecret,
} from "@/lib/api/hooks/use-workflow-secrets";
import { useCan } from "@/lib/hooks/use-permissions";

/**
 * The WRITE-ONLY credential field for a connection (frontend.md §4b) — the inverse of the
 * service-account one-time reveal. The API returns only the REDACTED descriptor (`configured: true` +
 * `label`); the cleartext is NEVER read back (INV-6). A configured secret renders as a masked,
 * non-refetchable `••••••••` with a Replace control; an unset one offers an entry field. Entry/rotation
 * is gated on `workflow:secrets` (separation of duties from `workflow:manage`) — a manage-only holder
 * sees the masked descriptor but no Replace control. The cleartext lives only in this component's local
 * state and is never written to the query cache.
 */
export function WorkflowSecretField({
  applicationId,
  connectionId,
  secret,
  defaultLabel,
}: {
  applicationId: string;
  connectionId: string;
  /** The redacted descriptor currently linked to this connection, or undefined when unset. */
  secret: WorkflowSecret | undefined;
  /** A sensible default `label` for a newly-entered credential (e.g. the connection name). */
  defaultLabel: string;
}) {
  const t = useTranslations("workflow");
  const canManageSecrets = useCan("workflow:secrets");

  const createSecret = useCreateWorkflowSecret();
  const rotateSecret = useRotateWorkflowSecret();
  const deleteSecret = useDeleteWorkflowSecret();
  const updateConnection = useUpdateWorkflowConnection();

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [label, setLabel] = useState(defaultLabel);

  const isPending =
    createSecret.isPending ||
    rotateSecret.isPending ||
    deleteSecret.isPending ||
    updateConnection.isPending;

  function reset() {
    setEditing(false);
    setValue("");
    setLabel(defaultLabel);
  }

  function save() {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;

    if (secret) {
      // Rotate in place — the secret stays linked to the connection.
      rotateSecret.mutate(
        { id: secret.id, value: trimmed },
        {
          onSuccess: () => {
            toast.success(t("secret.toastRotated"));
            reset();
          },
          onError: (err) => notifyError(err, t("secret.toastError")),
        },
      );
      return;
    }

    // Create + link: persist the credential, then point the connection at it.
    createSecret.mutate(
      {
        applicationId,
        connectionId,
        label: label.trim() || defaultLabel,
        value: trimmed,
      },
      {
        onSuccess: (created) => {
          updateConnection.mutate(
            { id: connectionId, data: { secretId: created.id } },
            {
              onSuccess: () => {
                toast.success(t("secret.toastSaved"));
                reset();
              },
              onError: (err) => notifyError(err, t("secret.toastError")),
            },
          );
        },
        onError: (err) => notifyError(err, t("secret.toastError")),
      },
    );
  }

  function remove() {
    if (!secret) return;
    deleteSecret.mutate(secret.id, {
      onSuccess: () => {
        updateConnection.mutate({
          id: connectionId,
          data: { secretId: null },
        });
        toast.success(t("secret.toastRemoved"));
      },
      onError: (err) => notifyError(err, t("secret.toastError")),
    });
  }

  if (editing) {
    return (
      <Field>
        <FieldLabel htmlFor="wf-secret-value">
          {secret ? t("secret.newValueLabel") : t("secret.valueLabel")}
        </FieldLabel>
        {!secret ? (
          <Input
            id="wf-secret-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t("secret.labelPlaceholder")}
            maxLength={120}
            className="mb-2"
            aria-label={t("secret.labelLabel")}
          />
        ) : null}
        <Input
          id="wf-secret-value"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("secret.valuePlaceholder")}
          maxLength={8192}
          autoComplete="off"
          autoFocus
        />
        <FieldDescription>{t("secret.writeOnlyHint")}</FieldDescription>
        <div className="mt-2 flex gap-2">
          <Button
            type="button"
            size="sm"
            onClick={save}
            disabled={isPending || value.trim().length === 0}
          >
            {isPending && <ArrowPathIcon className="animate-spin" />}
            {t("secret.save")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={reset}
            disabled={isPending}
          >
            {t("secret.cancel")}
          </Button>
        </div>
      </Field>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <LockClosedIcon className="size-4 text-muted-foreground" aria-hidden />
      {secret ? (
        <>
          <code className="font-mono text-sm text-muted-foreground">
            ••••••••
          </code>
          <span className="text-sm text-muted-foreground">{secret.label}</span>
          {canManageSecrets ? (
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setEditing(true)}
                disabled={isPending}
              >
                {t("secret.replace")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={remove}
                disabled={isPending}
              >
                {t("secret.remove")}
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <span className="text-sm text-muted-foreground">
            {t("secret.notConfigured")}
          </span>
          {canManageSecrets ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
            >
              {t("secret.add")}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
