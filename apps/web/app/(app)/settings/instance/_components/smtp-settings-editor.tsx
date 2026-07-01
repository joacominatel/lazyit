"use client";

import {
  ArrowPathIcon,
  EnvelopeIcon,
  PaperAirplaneIcon,
} from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  SMTP_SECURITY_MODES,
  type SmtpSecurity,
  SendTestEmailSchema,
  type UpdateSmtpSettings,
  UpdateSmtpSettingsSchema,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Controller, type Resolver, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { RequestIdNote } from "@/components/request-id-note";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api/client";
import {
  useSendTestEmail,
  useSmtpSettings,
  useUpdateSmtpSettings,
} from "@/lib/api/hooks/use-smtp-settings";
import { notifyError } from "@/lib/api/notify-error";

/** A blank string field → null (the "unset" value the nullish schema fields accept). */
function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? value : null;
}

/**
 * Settings → Instance: the outbound-email (SMTP) editor (ADR-0079, #615). A `settings:manage` ADMIN
 * configures the SMTP relay that backs email notifications — host/port/security/auth + the envelope
 * From — and can send a one-off test. The PASSWORD is write-only (INV-6-style): the read shape only
 * carries `passwordSet`, so the field renders a "configured — leave blank to keep" hint and is only
 * submitted when the admin types a new value (an empty password keeps the stored one).
 *
 * Mirrors {@link AssetTagSchemeEditor}: a query + mutation + form under the page's {@link AdminGate}
 * (the API's guard is the real boundary — a 403/409 surfaces as a toast). The form re-seeds from the
 * persisted truth after every save, so `passwordSet` and the redacted fields never drift from storage.
 */
export function SmtpSettingsEditor() {
  const t = useTranslations("settings.smtp");
  const { data, isLoading, isError, error, refetch, isFetching } =
    useSmtpSettings();
  const update = useUpdateSmtpSettings();
  const test = useSendTestEmail();

  const requestId = error instanceof ApiError ? error.requestId : undefined;

  const form = useForm<UpdateSmtpSettings>({
    resolver: zodResolver(UpdateSmtpSettingsSchema) as Resolver<UpdateSmtpSettings>,
    defaultValues: {
      enabled: false,
      host: null,
      port: null,
      security: "starttls",
      username: null,
      password: undefined,
      fromAddress: null,
      fromName: null,
      rejectUnauthorized: true,
    },
  });
  const { control, reset, handleSubmit, formState } = form;

  // Re-seed the form whenever the server settings change (initial load + after every save). `password`
  // is intentionally LEFT BLANK — it's write-only; the read never carries it, and pre-filling anything
  // would either leak or wipe the stored secret. Its "configured" state comes from `passwordSet`.
  useEffect(() => {
    if (!data) return;
    reset({
      enabled: data.enabled,
      host: data.host ?? null,
      port: data.port ?? null,
      security: data.security,
      username: data.username ?? null,
      password: undefined,
      fromAddress: data.fromAddress ?? null,
      fromName: data.fromName ?? null,
      rejectUnauthorized: data.rejectUnauthorized,
    });
  }, [data, reset]);

  const enabled = useWatch({ control, name: "enabled" });

  /** Human labels for the closed set of transport-security modes (mirrors the identity-provider map). */
  const securityLabel: Record<SmtpSecurity, string> = {
    none: t("fields.security.options.none"),
    starttls: t("fields.security.options.starttls"),
    tls: t("fields.security.options.tls"),
  };

  const onSubmit = handleSubmit((values) => {
    // `values` is already the schema shape (zodResolver validated it). Strip an empty password so the
    // stored secret is KEPT — only a non-empty value sets/rotates it (the write-only contract).
    const payload: UpdateSmtpSettings = { ...values };
    if (!payload.password || payload.password.trim() === "") {
      delete payload.password;
    }
    update.mutate(payload, {
      onSuccess: () => toast.success(t("toast.saved")),
      // A 409 (password supplied but SMTP_SECRET_KEY unset) surfaces its explanatory message here.
      onError: (err) => notifyError(err, t("toast.saveError")),
    });
  });

  // Test-email destination — a small inline input. The test uses the SAVED config (not the live form),
  // so the admin saves first; the destination is validated with the shared schema before the round-trip.
  const [testTo, setTestTo] = useState("");
  const onSendTest = () => {
    const parsed = SendTestEmailSchema.safeParse({ to: testTo.trim() });
    if (!parsed.success) {
      toast.error(t("test.invalidEmail"));
      return;
    }
    test.mutate(parsed.data, {
      onSuccess: (result) => {
        if (result.ok) {
          toast.success(t("test.success", { to: parsed.data.to }));
        } else {
          toast.error(t("test.failure"), {
            description: result.error ?? undefined,
          });
        }
      },
      onError: (err) => notifyError(err, t("test.error")),
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <EnvelopeIcon className="size-5 text-muted-foreground" />
          <CardTitle>{t("title")}</CardTitle>
        </div>
        <CardDescription>{t("subtitle")}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center gap-3 py-2 text-center">
            <p className="text-sm font-medium">{t("loadError")}</p>
            <p className="text-sm text-muted-foreground">
              {t("loadErrorHint")}
            </p>
            <RequestIdNote requestId={requestId} />
            <Button variant="outline" onClick={() => refetch()}>
              <ArrowPathIcon className={isFetching ? "animate-spin" : undefined} />
              {t("retry")}
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} noValidate className="space-y-6">
            <FieldGroup>
              {/* Enabled toggle — the master on/off for outbound email (test still works while off). */}
              <Controller
                control={control}
                name="enabled"
                render={({ field }) => (
                  <Field
                    orientation="horizontal"
                    className="rounded-lg border bg-muted/20 p-3"
                  >
                    <div className="flex flex-1 flex-col gap-0.5">
                      <FieldLabel htmlFor="smtp-enabled" className="font-medium">
                        {t("fields.enabled.label")}
                      </FieldLabel>
                      <FieldDescription>
                        {t("fields.enabled.description")}
                      </FieldDescription>
                    </div>
                    <Switch
                      id="smtp-enabled"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </Field>
                )}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <Controller
                  control={control}
                  name="host"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid || undefined}>
                      <FieldLabel htmlFor="smtp-host">
                        {t("fields.host.label")}
                      </FieldLabel>
                      <Input
                        id="smtp-host"
                        name={field.name}
                        ref={field.ref}
                        value={field.value ?? ""}
                        onBlur={field.onBlur}
                        onChange={(event) =>
                          field.onChange(emptyToNull(event.target.value))
                        }
                        placeholder={t("fields.host.placeholder")}
                        autoComplete="off"
                        aria-invalid={fieldState.invalid || undefined}
                      />
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />

                <Controller
                  control={control}
                  name="port"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid || undefined}>
                      <FieldLabel htmlFor="smtp-port">
                        {t("fields.port.label")}
                      </FieldLabel>
                      <Input
                        id="smtp-port"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={65535}
                        name={field.name}
                        ref={field.ref}
                        value={field.value ?? ""}
                        onBlur={field.onBlur}
                        onChange={(event) =>
                          field.onChange(
                            event.target.value === ""
                              ? null
                              : event.target.valueAsNumber,
                          )
                        }
                        placeholder={t("fields.port.placeholder")}
                        aria-invalid={fieldState.invalid || undefined}
                      />
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />
              </div>

              <Controller
                control={control}
                name="security"
                render={({ field }) => (
                  <Field>
                    <FieldLabel htmlFor="smtp-security">
                      {t("fields.security.label")}
                    </FieldLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="smtp-security" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SMTP_SECURITY_MODES.map((mode) => (
                          <SelectItem key={mode} value={mode}>
                            {securityLabel[mode]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <Controller
                  control={control}
                  name="username"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid || undefined}>
                      <FieldLabel htmlFor="smtp-username">
                        {t("fields.username.label")}
                      </FieldLabel>
                      <Input
                        id="smtp-username"
                        name={field.name}
                        ref={field.ref}
                        value={field.value ?? ""}
                        onBlur={field.onBlur}
                        onChange={(event) =>
                          field.onChange(emptyToNull(event.target.value))
                        }
                        placeholder={t("fields.username.placeholder")}
                        autoComplete="off"
                        aria-invalid={fieldState.invalid || undefined}
                      />
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />

                <Controller
                  control={control}
                  name="password"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid || undefined}>
                      <FieldLabel htmlFor="smtp-password">
                        {t("fields.password.label")}
                      </FieldLabel>
                      <Input
                        id="smtp-password"
                        type="password"
                        name={field.name}
                        ref={field.ref}
                        value={field.value ?? ""}
                        onBlur={field.onBlur}
                        onChange={(event) => field.onChange(event.target.value)}
                        placeholder={
                          data?.passwordSet
                            ? t("fields.password.placeholderSet")
                            : t("fields.password.placeholderUnset")
                        }
                        autoComplete="new-password"
                        aria-invalid={fieldState.invalid || undefined}
                      />
                      {data?.passwordSet ? (
                        <FieldDescription>
                          {t("fields.password.hintSet")}
                        </FieldDescription>
                      ) : null}
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Controller
                  control={control}
                  name="fromAddress"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid || undefined}>
                      <FieldLabel htmlFor="smtp-from-address">
                        {t("fields.fromAddress.label")}
                      </FieldLabel>
                      <Input
                        id="smtp-from-address"
                        type="email"
                        name={field.name}
                        ref={field.ref}
                        value={field.value ?? ""}
                        onBlur={field.onBlur}
                        onChange={(event) =>
                          field.onChange(emptyToNull(event.target.value))
                        }
                        placeholder={t("fields.fromAddress.placeholder")}
                        autoComplete="off"
                        aria-invalid={fieldState.invalid || undefined}
                      />
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />

                <Controller
                  control={control}
                  name="fromName"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid || undefined}>
                      <FieldLabel htmlFor="smtp-from-name">
                        {t("fields.fromName.label")}
                      </FieldLabel>
                      <Input
                        id="smtp-from-name"
                        name={field.name}
                        ref={field.ref}
                        value={field.value ?? ""}
                        onBlur={field.onBlur}
                        onChange={(event) =>
                          field.onChange(emptyToNull(event.target.value))
                        }
                        placeholder={t("fields.fromName.placeholder")}
                        autoComplete="off"
                        aria-invalid={fieldState.invalid || undefined}
                      />
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />
              </div>

              {/* TLS cert verification — a secure default (on); off allows a self-signed relay cert. */}
              <Controller
                control={control}
                name="rejectUnauthorized"
                render={({ field }) => (
                  <Field
                    orientation="horizontal"
                    className="rounded-lg border bg-muted/20 p-3"
                  >
                    <div className="flex flex-1 flex-col gap-0.5">
                      <FieldLabel
                        htmlFor="smtp-reject-unauthorized"
                        className="font-medium"
                      >
                        {t("fields.rejectUnauthorized.label")}
                      </FieldLabel>
                      <FieldDescription>
                        {t("fields.rejectUnauthorized.description")}
                      </FieldDescription>
                    </div>
                    <Switch
                      id="smtp-reject-unauthorized"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </Field>
                )}
              />

              {!enabled ? (
                <p className="text-sm text-muted-foreground">
                  {t("disabledHint")}
                </p>
              ) : null}
            </FieldGroup>

            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={update.isPending || !formState.isDirty}
              >
                {update.isPending && <ArrowPathIcon className="animate-spin" />}
                {t("save")}
              </Button>
            </div>

            {/* Send-test section — uses the SAVED config, so it lives below Save and nudges saving first.
                It is intentionally NOT gated on `enabled` (a test works even while email is off). */}
            <div className="space-y-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
              <p className="text-sm font-medium">{t("test.heading")}</p>
              <p className="text-sm text-muted-foreground">
                {t("test.description")}
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  type="email"
                  value={testTo}
                  onChange={(event) => setTestTo(event.target.value)}
                  placeholder={t("test.placeholder")}
                  autoComplete="off"
                  className="bg-background"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0"
                  onClick={onSendTest}
                  disabled={test.isPending || testTo.trim() === ""}
                >
                  {test.isPending ? (
                    <ArrowPathIcon className="animate-spin" />
                  ) : (
                    <PaperAirplaneIcon />
                  )}
                  {t("test.send")}
                </Button>
              </div>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
