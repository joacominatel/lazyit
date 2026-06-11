"use client";

import { ArrowPathIcon, LockClosedIcon } from "@heroicons/react/24/outline";
import {
  type WorkflowConnection,
  type WorkflowRestAuthScheme,
  type WorkflowSecret,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { notifyError } from "@/lib/api/notify-error";
import { useUpdateWorkflowConnection } from "@/lib/api/hooks/use-workflow-connections";
import {
  useCreateWorkflowSecret,
  useDeleteWorkflowSecret,
  useRotateWorkflowSecret,
} from "@/lib/api/hooks/use-workflow-secrets";
import { useCan } from "@/lib/hooks/use-permissions";
import {
  BINDABLE_AUTH_SCHEMES,
  type BindableAuthScheme,
  deriveSchemePatch,
} from "@/lib/workflow/credential-scheme";

/**
 * The WRITE-ONLY credential field for a connection (frontend.md §4b) — the inverse of the
 * service-account one-time reveal. The API returns only the REDACTED descriptor (`configured: true` +
 * `label`); the cleartext is NEVER read back (INV-6). A configured secret renders as a masked,
 * non-refetchable `••••••••` with a Replace control; an unset one offers an entry field.
 *
 * GUIDED CREDENTIAL TYPE (#342, Option B "guide it"). For a REST connection the add-credential flow
 * captures the AUTH TYPE together with the value, not just the value: when the connection's `authScheme`
 * is `NONE` there is nothing to attach a secret to, so the flow first makes the operator choose a real
 * scheme (Bearer / Basic / API-key header, + the header name for HEADER) and sets it on the connection
 * AS PART OF binding — no orphan credential. When a scheme is already set, the flow keeps it and only
 * collects the value. SoD (ADR-0054 §6.4): SETTING the scheme/config needs `workflow:manage`; binding
 * the SECRET needs `workflow:secrets` — both ADMIN-by-default, so the common admin path is unchanged. A
 * `workflow:secrets`-only holder cannot create an orphan on a `NONE` connection: the add control is gated
 * until someone with `workflow:manage` sets an auth method.
 *
 * Entry/rotation is gated on `workflow:secrets`. The cleartext lives only in this component's local
 * state and is never written to the query cache.
 */
export function WorkflowSecretField({
  applicationId,
  connection,
  secret,
  defaultLabel,
}: {
  applicationId: string;
  /** The connection this credential is bound to (drives the REST auth-type guidance, #342). */
  connection: WorkflowConnection;
  /** The redacted descriptor currently linked to this connection, or undefined when unset. */
  secret: WorkflowSecret | undefined;
  /** A sensible default `label` for a newly-entered credential (e.g. the connection name). */
  defaultLabel: string;
}) {
  const t = useTranslations("workflow");
  const canManageSecrets = useCan("workflow:secrets");
  const canManage = useCan("workflow:manage");

  const createSecret = useCreateWorkflowSecret();
  const rotateSecret = useRotateWorkflowSecret();
  const deleteSecret = useDeleteWorkflowSecret();
  const updateConnection = useUpdateWorkflowConnection();

  const config = connection.config;
  const connectionId = connection.id;
  const isRest = config.kind === "REST";
  const currentScheme: WorkflowRestAuthScheme | undefined =
    config.kind === "REST" ? config.authScheme : undefined;
  // A REST connection needs a scheme chosen as part of binding when none is set yet (`NONE`).
  const needsSchemeChoice = isRest && currentScheme === "NONE";

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [label, setLabel] = useState(defaultLabel);
  // The scheme the operator picks while binding (only used for a REST connection).
  const [scheme, setScheme] = useState<BindableAuthScheme>(
    currentScheme && currentScheme !== "NONE" ? currentScheme : "BEARER",
  );
  const [headerName, setHeaderName] = useState(
    config.kind === "REST" ? (config.authHeaderName ?? "") : "",
  );

  const isPending =
    createSecret.isPending ||
    rotateSecret.isPending ||
    deleteSecret.isPending ||
    updateConnection.isPending;

  function reset() {
    setEditing(false);
    setValue("");
    setLabel(defaultLabel);
    setScheme(
      currentScheme && currentScheme !== "NONE" ? currentScheme : "BEARER",
    );
    setHeaderName(config.kind === "REST" ? (config.authHeaderName ?? "") : "");
  }

  function persistSecret() {
    const trimmed = value.trim();
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

  function save() {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;

    if (secret) {
      // Rotate in place — the secret (and the connection's auth scheme) stay as configured.
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

    // Derive the auth-scheme config patch for the GUIDED bind (#342). Rotating an existing secret never
    // re-touches the scheme, so the derivation only runs when adding a NEW credential.
    const derived = deriveSchemePatch({ config, scheme, headerName });
    if (!derived.ok) {
      // HEADER scheme picked without a header name — surface a clear, non-blocking error.
      notifyError(
        new Error(derived.reason),
        t("secret.authHeaderRequired"),
      );
      return;
    }
    if (derived.patch === undefined) {
      // No scheme change needed (or non-REST) — just bind the secret.
      persistSecret();
      return;
    }
    // Guided bind: set the auth scheme on the connection FIRST (workflow:manage), then the secret.
    updateConnection.mutate(
      { id: connectionId, data: { config: derived.patch } },
      {
        onSuccess: () => persistSecret(),
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
    // Show the auth-type chooser only when BINDING a new credential to a REST connection (not on
    // rotation, where the scheme is already set — change it in the connection form instead).
    const showSchemeChooser = isRest && !secret;
    return (
      <Field>
        {showSchemeChooser ? (
          <div className="mb-3 space-y-2">
            <FieldLabel htmlFor="wf-secret-scheme">
              {t("secret.authTypeLabel")}
            </FieldLabel>
            <Select
              value={scheme}
              onValueChange={(v) => setScheme(v as BindableAuthScheme)}
            >
              <SelectTrigger id="wf-secret-scheme">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BINDABLE_AUTH_SCHEMES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`authScheme.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {scheme === "HEADER" ? (
              <Input
                id="wf-secret-header"
                value={headerName}
                onChange={(e) => setHeaderName(e.target.value)}
                placeholder="X-Api-Key"
                maxLength={100}
                aria-label={t("secret.authHeaderLabel")}
              />
            ) : null}
            <FieldDescription>{t("secret.authTypeHint")}</FieldDescription>
          </div>
        ) : null}
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
            // A REST connection with no auth scheme needs a scheme chosen as part of binding — which
            // requires workflow:manage (SoD). Gate the add control until that holder can set one, so a
            // secrets-only holder can never create an orphan credential with no scheme (#342).
            needsSchemeChoice && !canManage ? (
              <span className="text-xs text-muted-foreground">
                {t("secret.needsSchemeHint")}
              </span>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setEditing(true)}
              >
                {t("secret.add")}
              </Button>
            )
          ) : null}
        </>
      )}
    </div>
  );
}
