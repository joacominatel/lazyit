"use client";

import {
  ArrowPathIcon,
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
import { Controller, type Resolver, useForm } from "react-hook-form";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { RequestIdNote } from "@/components/request-id-note";
import {
  SettingLabel,
  SettingRow,
  SettingsSaveBar,
  SettingsSection,
  SettingsStatus,
} from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
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

/** The Manual page the section's "?" links to. */
const MANUAL_HREF = "/help/configuration-smtp-email";

/** A blank string field → null (the "unset" value the nullish schema fields accept). */
function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? value : null;
}

/**
 * Settings → Email: the outbound-email (SMTP) page (ADR-0079, #615; its own route since #1533). A `settings:manage` ADMIN
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
  const tSettings = useTranslations("settings");
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

  /** A text input bound to one nullable string field (blank → null). */
  const textField = (
    name: "host" | "username" | "fromAddress" | "fromName",
    id: string,
    extra?: { type?: string; className?: string },
  ) => (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field
          data-invalid={fieldState.invalid || undefined}
          className={extra?.className}
        >
          <FieldLabel htmlFor={id}>{t(`fields.${name}.label`)}</FieldLabel>
          <Input
            id={id}
            type={extra?.type}
            name={field.name}
            ref={field.ref}
            value={field.value ?? ""}
            onBlur={field.onBlur}
            onChange={(event) => field.onChange(emptyToNull(event.target.value))}
            placeholder={t(`fields.${name}.placeholder`)}
            autoComplete="off"
            aria-invalid={fieldState.invalid || undefined}
          />
          <FieldError errors={[fieldState.error]} />
        </Field>
      )}
    />
  );

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        badge={
          data ? <SettingsStatus state={data.enabled ? "on" : "off"} /> : null
        }
      />

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-80 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      ) : isError ? (
        <div className="flex flex-col items-center gap-3 rounded-xl py-8 text-center ring-1 ring-foreground/10">
          <p className="text-sm font-medium">{t("loadError")}</p>
          <p className="text-sm text-muted-foreground">{t("loadErrorHint")}</p>
          <RequestIdNote requestId={requestId} />
          <Button variant="outline" onClick={() => refetch()}>
            <ArrowPathIcon className={isFetching ? "animate-spin" : undefined} />
            {t("retry")}
          </Button>
        </div>
      ) : (
        <>
          <form onSubmit={onSubmit} noValidate>
            <SettingsSection
              title={t("server.title")}
              summary={t("server.summary")}
              help={<p>{t("server.help")}</p>}
              helpHref={MANUAL_HREF}
              actions={
                // The master on/off for outbound email. Part of this form — it saves with Save, as it
                // always has (a test still works while it is off).
                <Controller
                  control={control}
                  name="enabled"
                  render={({ field }) => (
                    <div className="flex items-center gap-2">
                      <SettingLabel
                        htmlFor="smtp-enabled"
                        help={<p>{t("fields.enabled.description")}</p>}
                      >
                        {t("fields.enabled.label")}
                      </SettingLabel>
                      <Switch
                        id="smtp-enabled"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </div>
                  )}
                />
              }
              footer={
                <SettingsSaveBar
                  note={
                    formState.isDirty
                      ? tSettings("section.unsaved")
                      : tSettings("section.noChanges")
                  }
                >
                  <Button
                    type="submit"
                    size="sm"
                    disabled={update.isPending || !formState.isDirty}
                  >
                    {update.isPending && <ArrowPathIcon className="animate-spin" />}
                    {t("save")}
                  </Button>
                </SettingsSaveBar>
              }
            >
              {/* Port only ever holds five digits, so it gets a fixed narrow track and the Security select
                  the room its option labels need ("STARTTLS (recommended, port 587)"). */}
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_6rem_minmax(0,1fr)]">
                {textField("host", "smtp-host")}

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
                        className="font-mono"
                        aria-invalid={fieldState.invalid || undefined}
                      />
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />

                <Controller
                  control={control}
                  name="security"
                  render={({ field }) => (
                    <Field>
                      <SettingLabel
                        htmlFor="smtp-security"
                        help={<p>{t("fields.security.help")}</p>}
                      >
                        {t("fields.security.label")}
                      </SettingLabel>
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
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                {textField("username", "smtp-username")}

                <Controller
                  control={control}
                  name="password"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid || undefined}>
                      <SettingLabel
                        htmlFor="smtp-password"
                        help={<p>{t("fields.password.help")}</p>}
                      >
                        {t("fields.password.label")}
                      </SettingLabel>
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
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />

                {textField("fromAddress", "smtp-from-address", { type: "email" })}
                {textField("fromName", "smtp-from-name")}
              </div>

              {/* TLS cert verification — a secure default (on); off allows a self-signed relay cert. */}
              <div className="border-t pt-4">
                <Controller
                  control={control}
                  name="rejectUnauthorized"
                  render={({ field }) => (
                    <SettingRow
                      label={t("fields.rejectUnauthorized.label")}
                      htmlFor="smtp-reject-unauthorized"
                      help={<p>{t("fields.rejectUnauthorized.description")}</p>}
                    >
                      <Switch
                        id="smtp-reject-unauthorized"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </SettingRow>
                  )}
                />
              </div>
            </SettingsSection>
          </form>

          {/* Send-test — uses the SAVED config, so it sits apart from the form and its Save. It is
              intentionally NOT gated on `enabled` (a test works even while email is off). */}
          <SettingsSection
            title={t("test.heading")}
            summary={t("test.description")}
            actions={
              <>
                <Input
                  type="email"
                  value={testTo}
                  onChange={(event) => setTestTo(event.target.value)}
                  placeholder={t("test.placeholder")}
                  aria-label={t("test.toLabel")}
                  autoComplete="off"
                  className="w-full sm:w-56"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
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
              </>
            }
          />
        </>
      )}
    </div>
  );
}
