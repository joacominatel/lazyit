"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import {
  type CreateWorkflowConnection,
  CreateWorkflowConnectionSchema,
  WORKFLOW_CONNECTION_KINDS_V1,
  WORKFLOW_REST_AUTH_SCHEMES,
  type WorkflowConnection,
  type WorkflowConnectionConfig,
  type WorkflowConnectionKind,
  type WorkflowProbeMethod,
  type WorkflowRestAuthScheme,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { notifyError } from "@/lib/api/notify-error";
import {
  useCreateWorkflowConnection,
  useUpdateWorkflowConnection,
} from "@/lib/api/hooks/use-workflow-connections";

const FORM_ID = "workflow-connection-form";

interface FormState {
  kind: (typeof WORKFLOW_CONNECTION_KINDS_V1)[number];
  name: string;
  /** REST base URL / WEBHOOK_OUT url — a public https URL (validated by the shared zod). */
  url: string;
  authScheme: WorkflowRestAuthScheme;
  authHeaderName: string;
  signatureHeader: string;
  /** REST: optional path the "Test connection" probe targets (e.g. /health), else baseUrl (#344). */
  healthCheckPath: string;
  /**
   * REST: the probe method, preserved across an edit so it is not silently dropped. The form does not
   * expose a method picker yet (GET is the sensible default); the schema bounds it to READ-ONLY verbs.
   */
  healthCheckMethod: WorkflowProbeMethod | undefined;
}

function initialState(connection?: WorkflowConnection): FormState {
  if (connection) {
    const config = connection.config;
    return {
      kind: connection.kind as (typeof WORKFLOW_CONNECTION_KINDS_V1)[number],
      name: connection.name,
      url: config.kind === "REST" ? config.baseUrl : config.kind === "WEBHOOK_OUT" ? config.url : "",
      authScheme: config.kind === "REST" ? config.authScheme : "NONE",
      authHeaderName:
        config.kind === "REST" ? (config.authHeaderName ?? "") : "",
      signatureHeader:
        config.kind === "WEBHOOK_OUT" ? (config.signatureHeader ?? "") : "",
      healthCheckPath:
        config.kind === "REST" ? (config.healthCheckPath ?? "") : "",
      healthCheckMethod:
        config.kind === "REST" ? config.healthCheckMethod : undefined,
    };
  }
  return {
    kind: "REST",
    name: "",
    url: "",
    authScheme: "NONE",
    authHeaderName: "",
    signatureHeader: "",
    healthCheckPath: "",
    healthCheckMethod: undefined,
  };
}

/** Build the per-kind config object from the flat form state. */
function buildConfig(values: FormState): WorkflowConnectionConfig {
  switch (values.kind) {
    case "REST":
      return {
        kind: "REST",
        baseUrl: values.url.trim(),
        authScheme: values.authScheme,
        ...(values.authScheme === "HEADER" && values.authHeaderName.trim()
          ? { authHeaderName: values.authHeaderName.trim() }
          : {}),
        ...(values.healthCheckPath.trim()
          ? { healthCheckPath: values.healthCheckPath.trim() }
          : {}),
        ...(values.healthCheckMethod
          ? { healthCheckMethod: values.healthCheckMethod }
          : {}),
      };
    case "WEBHOOK_OUT":
      return {
        kind: "WEBHOOK_OUT",
        url: values.url.trim(),
        ...(values.signatureHeader.trim()
          ? { signatureHeader: values.signatureHeader.trim() }
          : {}),
      };
    case "MANUAL":
      return { kind: "MANUAL" };
  }
}

export function ConnectionFormDialog({
  open,
  onOpenChange,
  applicationId,
  connection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  applicationId: string;
  /** Present → edit that connection; absent → create a new one. */
  connection?: WorkflowConnection;
}) {
  const recordKey = connection ? `edit-${connection.id}` : "new";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        {open ? (
          <ConnectionForm
            key={recordKey}
            applicationId={applicationId}
            connection={connection}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ConnectionForm({
  applicationId,
  connection,
  onClose,
}: {
  applicationId: string;
  connection?: WorkflowConnection;
  onClose: () => void;
}) {
  const t = useTranslations("workflow");
  const tc = useTranslations("common");
  const isEdit = connection != null;
  const create = useCreateWorkflowConnection();
  const update = useUpdateWorkflowConnection();
  const isPending = create.isPending || update.isPending;

  const [values, setValues] = useState<FormState>(() =>
    initialState(connection),
  );
  const [error, setError] = useState<string | undefined>(undefined);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const name = values.name.trim();
    if (name.length === 0) {
      setError(t("connectionForm.errors.nameRequired"));
      return;
    }
    const config = buildConfig(values);
    setError(undefined);

    if (connection) {
      // kind is immutable — patch name + config only.
      update.mutate(
        { id: connection.id, data: { name, config } },
        {
          onSuccess: () => {
            toast.success(t("connectionForm.toastUpdated"));
            onClose();
          },
          onError: (err) => notifyError(err, t("connectionForm.toastError")),
        },
      );
      return;
    }

    const body: CreateWorkflowConnection = {
      applicationId,
      kind: values.kind,
      name,
      config,
    };
    const parsed = CreateWorkflowConnectionSchema.safeParse(body);
    if (!parsed.success) {
      setError(t("connectionForm.errors.invalidFields"));
      return;
    }
    create.mutate(parsed.data, {
      onSuccess: () => {
        toast.success(t("connectionForm.toastCreated"));
        onClose();
      },
      onError: (err) => notifyError(err, t("connectionForm.toastError")),
    });
  }

  const needsUrl = values.kind === "REST" || values.kind === "WEBHOOK_OUT";

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {isEdit
            ? t("connectionForm.editTitle")
            : t("connectionForm.newTitle")}
        </DialogTitle>
        <DialogDescription>
          {t("connectionForm.description")}
        </DialogDescription>
      </DialogHeader>

      <form id={FORM_ID} onSubmit={handleSubmit} noValidate>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="wf-conn-kind">
              {t("connectionForm.kindLabel")}
            </FieldLabel>
            <Select
              value={values.kind}
              onValueChange={(v) =>
                set("kind", v as (typeof WORKFLOW_CONNECTION_KINDS_V1)[number])
              }
              disabled={isEdit}
            >
              <SelectTrigger id="wf-conn-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WORKFLOW_CONNECTION_KINDS_V1.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {t(`kind.${kind as WorkflowConnectionKind}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isEdit ? (
              <FieldDescription>
                {t("connectionForm.kindImmutable")}
              </FieldDescription>
            ) : null}
          </Field>

          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="wf-conn-name">
              {t("connectionForm.nameLabel")}
            </FieldLabel>
            <Input
              id="wf-conn-name"
              value={values.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder={t("connectionForm.namePlaceholder")}
              maxLength={120}
              autoFocus
            />
          </Field>

          {needsUrl ? (
            <Field>
              <FieldLabel htmlFor="wf-conn-url">
                {values.kind === "REST"
                  ? t("connectionForm.baseUrlLabel")
                  : t("connectionForm.webhookUrlLabel")}
              </FieldLabel>
              <Input
                id="wf-conn-url"
                type="url"
                inputMode="url"
                value={values.url}
                onChange={(e) => set("url", e.target.value)}
                placeholder="https://api.example.com"
              />
              <FieldDescription>
                {t("connectionForm.urlHint")}
              </FieldDescription>
            </Field>
          ) : null}

          {values.kind === "REST" ? (
            <>
              <Field>
                <FieldLabel htmlFor="wf-conn-auth">
                  {t("connectionForm.authLabel")}
                </FieldLabel>
                <Select
                  value={values.authScheme}
                  onValueChange={(v) =>
                    set("authScheme", v as WorkflowRestAuthScheme)
                  }
                >
                  <SelectTrigger id="wf-conn-auth">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WORKFLOW_REST_AUTH_SCHEMES.map((scheme) => (
                      <SelectItem key={scheme} value={scheme}>
                        {t(`authScheme.${scheme}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {values.authScheme === "HEADER" ? (
                <Field>
                  <FieldLabel htmlFor="wf-conn-auth-header">
                    {t("connectionForm.authHeaderLabel")}
                  </FieldLabel>
                  <Input
                    id="wf-conn-auth-header"
                    value={values.authHeaderName}
                    onChange={(e) => set("authHeaderName", e.target.value)}
                    placeholder="X-Api-Key"
                    maxLength={100}
                  />
                </Field>
              ) : null}
              <Field>
                <FieldLabel htmlFor="wf-conn-health-path">
                  {t("connectionForm.healthPathLabel")}
                </FieldLabel>
                <Input
                  id="wf-conn-health-path"
                  value={values.healthCheckPath}
                  onChange={(e) => set("healthCheckPath", e.target.value)}
                  placeholder="/health"
                  maxLength={2048}
                />
                <FieldDescription>
                  {t("connectionForm.healthPathHint")}
                </FieldDescription>
              </Field>
            </>
          ) : null}

          {values.kind === "WEBHOOK_OUT" ? (
            <Field>
              <FieldLabel htmlFor="wf-conn-sig">
                {t("connectionForm.signatureHeaderLabel")}
              </FieldLabel>
              <Input
                id="wf-conn-sig"
                value={values.signatureHeader}
                onChange={(e) => set("signatureHeader", e.target.value)}
                placeholder="X-Signature"
                maxLength={100}
              />
              <FieldDescription>
                {t("connectionForm.signatureHeaderHint")}
              </FieldDescription>
            </Field>
          ) : null}

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
            ? t("connectionForm.saveChanges")
            : t("connectionForm.createButton")}
        </Button>
      </div>
    </>
  );
}
