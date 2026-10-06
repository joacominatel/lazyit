"use client";

import {
  ArrowPathIcon,
  ArrowsRightLeftIcon,
} from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  DIRECTORY_TRANSPORT_MODES,
  type DirectoryTransport,
  type UpdateDirectoryConnection,
  UpdateDirectoryConnectionSchema,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { Controller, type Resolver, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { HelpTip } from "@/components/help-tip";
import { RequestIdNote } from "@/components/request-id-note";
import {
  SettingLabel,
  SettingRow,
  SettingsSaveBar,
  SettingsSection,
  SettingsStatus,
} from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
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
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api/client";
import {
  useDirectoryConnection,
  useSyncDirectoryNow,
  useUpdateDirectoryConnection,
} from "@/lib/api/hooks/use-directory-connection";
import { notifyError } from "@/lib/api/notify-error";
import { useFormatters } from "@/lib/hooks/use-formatters";
import {
  attributeInputsFrom,
  emptyToNull,
  toDirectoryPayload,
} from "./directory-form";
import { DirectoryPendingTray } from "./directory-pending-tray";

/** The Manual page the sections' "?" tips link to. */
const MANUAL_HREF = "/help/configuration-directory-sync";

/** Default attribute-name suggestions for a typical Active Directory (only placeholders, not values). */
const AD_ATTR_PLACEHOLDER: Record<string, string> = {
  firstName: "givenName",
  lastName: "sn",
  email: "mail",
  username: "sAMAccountName",
};

/**
 * Settings → Directory: the AD/LDAP directory-source page (issue #839, ADR-0091; its own route since
 * #1533). A `settings:manage`
 * ADMIN points lazyit at an on-prem directory that is READ-ONLY imported: lazyit binds read-only,
 * subtree-searches, and upserts login-less `directoryOnly` persons. It NEVER writes back to AD and is NOT a
 * login method.
 *
 * Mirrors {@link SmtpSettingsEditor}: a query + mutation + form under the page's AdminGate (the API's guard
 * is the real boundary — a 403/409 surfaces as a toast). The BIND PASSWORD is write-only (the read shape
 * carries only `bindPasswordSet`), so the field renders a "configured — leave blank to keep" hint and is
 * only submitted when the admin types a new value. The four recognized attribute mappings are held as local
 * state (assembled into the wire `attributeMap` at submit — see {@link toDirectoryPayload}); the refined
 * DN / filter fields flow through react-hook-form for native field-level errors.
 *
 * "Sync now" runs the SAME read-only reconcile the sweeper runs — it doubles as the bind/connectivity check
 * — and the result panel surfaces the last run's status, counts, and any short (non-secret) error.
 */
export function DirectorySettingsEditor() {
  const t = useTranslations("settings.directory");
  const tSettings = useTranslations("settings");
  const { date } = useFormatters();
  const { data, isLoading, isError, error, refetch, isFetching } =
    useDirectoryConnection();
  const update = useUpdateDirectoryConnection();
  const sync = useSyncDirectoryNow();

  const requestId = error instanceof ApiError ? error.requestId : undefined;

  const form = useForm<UpdateDirectoryConnection>({
    resolver: zodResolver(
      UpdateDirectoryConnectionSchema,
    ) as Resolver<UpdateDirectoryConnection>,
    defaultValues: {
      enabled: false,
      host: null,
      port: null,
      transport: "ldaps",
      rejectUnauthorized: true,
      baseDN: null,
      bindDN: null,
      searchFilter: null,
      offboardGraceDays: 7,
      bindPassword: undefined,
      // The four recognized profile→AD-attribute inputs, carried as one object field so the whole form seeds
      // from a single `reset()` (blanks are dropped when assembling the wire map at submit).
      attributeMap: attributeInputsFrom(null),
    },
  });
  const { control, reset, handleSubmit, formState } = form;

  // Re-seed the form whenever the server settings change (initial load + after every save). `bindPassword` is
  // intentionally LEFT BLANK — it's write-only; pre-filling anything would either leak or wipe the stored
  // secret. Its "configured" state comes from `bindPasswordSet`.
  useEffect(() => {
    if (!data) return;
    reset({
      enabled: data.enabled,
      host: data.host ?? null,
      port: data.port ?? null,
      transport: data.transport,
      rejectUnauthorized: data.rejectUnauthorized,
      baseDN: data.baseDN ?? null,
      bindDN: data.bindDN ?? null,
      searchFilter: data.searchFilter ?? null,
      offboardGraceDays: data.offboardGraceDays,
      bindPassword: undefined,
      attributeMap: attributeInputsFrom(data.attributeMap),
    });
  }, [data, reset]);

  const transport = useWatch({ control, name: "transport" });

  /** Human labels for the closed set of transport-security modes. */
  const transportLabel: Record<DirectoryTransport, string> = {
    ldaps: t("fields.transport.options.ldaps"),
    starttls: t("fields.transport.options.starttls"),
    plaintext: t("fields.transport.options.plaintext"),
  };

  const onSubmit = handleSubmit((values) => {
    // `values` is the schema shape (zodResolver validated the refined DN / filter fields). The attribute
    // map is assembled and the write-only bind password stripped-when-blank by the pure helper.
    update.mutate(toDirectoryPayload(values), {
      onSuccess: () => toast.success(t("toast.saved")),
      // A 409 (bind password supplied but DIRECTORY_SECRET_KEY unset) surfaces its explanatory message here.
      onError: (err) => notifyError(err, t("toast.saveError")),
    });
  });

  // "Sync now" runs the saved config (save first, then sync). It is intentionally NOT gated on `enabled` —
  // an admin can validate the bind while the scheduled sweeper stays off.
  const onSyncNow = () => {
    sync.mutate(undefined, {
      onSuccess: (result) => {
        if (result.ok) {
          toast.success(t("sync.success"), {
            description: t("sync.counts", {
              created: result.counts.created,
              updated: result.counts.updated,
              offboarded: result.counts.offboarded,
              skipped: result.counts.skipped,
            }),
          });
        } else {
          toast.error(t("sync.failure"), {
            description: result.error ?? undefined,
          });
        }
      },
      onError: (err) => notifyError(err, t("sync.error")),
    });
  };

  /** The last-run status → a StatusBadge tone (never = neutral, ok = success, error = danger). */
  const statusTone: StatusTone =
    data?.lastSyncStatus === "ok"
      ? "success"
      : data?.lastSyncStatus === "error"
        ? "danger"
        : "neutral";

  /** A text input bound to one nullable string field (blank → null), with an optional "?" tip. */
  const textField = (
    name: "host" | "baseDN" | "bindDN" | "searchFilter",
    id: string,
    extra?: { help?: boolean; mono?: boolean; className?: string },
  ) => (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field
          data-invalid={fieldState.invalid || undefined}
          className={extra?.className}
        >
          <SettingLabel
            htmlFor={id}
            help={
              extra?.help ? <p>{t(`fields.${name}.description`)}</p> : undefined
            }
          >
            {t(`fields.${name}.label`)}
          </SettingLabel>
          <Input
            id={id}
            name={field.name}
            ref={field.ref}
            value={field.value ?? ""}
            onBlur={field.onBlur}
            onChange={(event) => field.onChange(emptyToNull(event.target.value))}
            placeholder={t(`fields.${name}.placeholder`)}
            autoComplete="off"
            className={extra?.mono ? "font-mono text-sm" : undefined}
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
        breadcrumb={
          <Breadcrumb
            items={[
              { label: tSettings("hub.title"), href: "/settings" },
              { label: t("title") },
            ]}
          />
        }
        badge={
          data ? <SettingsStatus state={data.enabled ? "on" : "off"} /> : null
        }
      />

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-96 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
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
              title={t("connection.title")}
              summary={t("connection.summary")}
              help={<p>{t("connection.help")}</p>}
              helpHref={MANUAL_HREF}
              actions={
                // The master on/off for the scheduled sweeper — part of this form, saved with Save as it
                // always has been (Sync now works while it is off).
                <Controller
                  control={control}
                  name="enabled"
                  render={({ field }) => (
                    <div className="flex items-center gap-2">
                      <SettingLabel
                        htmlFor="dir-enabled"
                        help={<p>{t("fields.enabled.description")}</p>}
                      >
                        {t("fields.enabled.label")}
                      </SettingLabel>
                      <Switch
                        id="dir-enabled"
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
                  {/* Not gated on `formState.isDirty`, as before — a re-save is always allowed. */}
                  <Button type="submit" size="sm" disabled={update.isPending}>
                    {update.isPending && <ArrowPathIcon className="animate-spin" />}
                    {t("save")}
                  </Button>
                </SettingsSaveBar>
              }
            >
              <div className="grid gap-4 sm:grid-cols-4">
                {textField("host", "dir-host", { className: "sm:col-span-3" })}

                <Controller
                  control={control}
                  name="port"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid || undefined}>
                      <FieldLabel htmlFor="dir-port">
                        {t("fields.port.label")}
                      </FieldLabel>
                      <Input
                        id="dir-port"
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
              </div>

              <Controller
                control={control}
                name="transport"
                render={({ field }) => (
                  <Field>
                    <SettingLabel
                      htmlFor="dir-transport"
                      help={
                        <ul className="space-y-1">
                          {DIRECTORY_TRANSPORT_MODES.map((mode) => (
                            <li key={mode}>
                              <span className="font-medium">
                                {transportLabel[mode]}
                              </span>{" "}
                              — {t(`fields.transport.hint.${mode}`)}
                            </li>
                          ))}
                        </ul>
                      }
                    >
                      {t("fields.transport.label")}
                    </SettingLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="dir-transport" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DIRECTORY_TRANSPORT_MODES.map((mode) => (
                          <SelectItem key={mode} value={mode}>
                            {transportLabel[mode]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {/* Plaintext sends the bind password in the clear — a risk, so it stays visible. */}
                    {field.value === "plaintext" ? (
                      <FieldDescription className="text-destructive">
                        {t("fields.transport.hint.plaintext")}
                      </FieldDescription>
                    ) : null}
                  </Field>
                )}
              />

              {textField("baseDN", "dir-base-dn", { help: true, mono: true })}

              <div className="grid gap-4 sm:grid-cols-2">
                {textField("bindDN", "dir-bind-dn", { help: true, mono: true })}

                <Controller
                  control={control}
                  name="bindPassword"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid || undefined}>
                      <SettingLabel
                        htmlFor="dir-bind-password"
                        help={<p>{t("fields.bindPassword.help")}</p>}
                      >
                        {t("fields.bindPassword.label")}
                      </SettingLabel>
                      <Input
                        id="dir-bind-password"
                        type="password"
                        name={field.name}
                        ref={field.ref}
                        value={field.value ?? ""}
                        onBlur={field.onBlur}
                        onChange={(event) => field.onChange(event.target.value)}
                        placeholder={
                          data?.bindPasswordSet
                            ? t("fields.bindPassword.placeholderSet")
                            : t("fields.bindPassword.placeholderUnset")
                        }
                        autoComplete="new-password"
                        aria-invalid={fieldState.invalid || undefined}
                      />
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />
              </div>

              {textField("searchFilter", "dir-search-filter", {
                help: true,
                mono: true,
              })}

              {/* Attribute map — the four recognized profile keys → AD attribute NAMES, assembled into
                  the wire `attributeMap` at submit (see directory-form.ts). */}
              <div className="space-y-3 border-t pt-4">
                <SettingLabel
                  help={<p>{t("fields.attributeMap.description")}</p>}
                >
                  {t("fields.attributeMap.label")}
                </SettingLabel>
                <div className="grid gap-4 sm:grid-cols-2">
                  {(
                    ["firstName", "lastName", "email", "username"] as const
                  ).map((key) => (
                    <Controller
                      key={key}
                      control={control}
                      name={`attributeMap.${key}`}
                      render={({ field }) => (
                        <Field>
                          <FieldLabel htmlFor={`dir-attr-${key}`}>
                            {t(`fields.attributeMap.keys.${key}`)}
                          </FieldLabel>
                          <Input
                            id={`dir-attr-${key}`}
                            name={field.name}
                            ref={field.ref}
                            value={field.value ?? ""}
                            onBlur={field.onBlur}
                            onChange={(event) => field.onChange(event.target.value)}
                            placeholder={AD_ATTR_PLACEHOLDER[key]}
                            autoComplete="off"
                            className="font-mono text-sm"
                          />
                        </Field>
                      )}
                    />
                  ))}
                </div>
              </div>

              <div className="space-y-0 border-t pt-4">
                {/* TLS cert verification — a secure default (on); off allows a self-signed internal
                    cert. Inert under plaintext (no TLS to verify), so the control is disabled and the
                    tip says why. */}
                <Controller
                  control={control}
                  name="rejectUnauthorized"
                  render={({ field }) => (
                    <SettingRow
                      label={t("fields.rejectUnauthorized.label")}
                      htmlFor="dir-reject-unauthorized"
                      help={
                        <p>
                          {transport === "plaintext"
                            ? t("fields.rejectUnauthorized.plaintextHint")
                            : t("fields.rejectUnauthorized.description")}
                        </p>
                      }
                    >
                      <Switch
                        id="dir-reject-unauthorized"
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        disabled={transport === "plaintext"}
                      />
                    </SettingRow>
                  )}
                />

                {/* The offboard grace, read as a sentence (#1533). Same field, bounds and error. */}
                <Controller
                  control={control}
                  name="offboardGraceDays"
                  render={({ field, fieldState }) => (
                    <Field
                      data-invalid={fieldState.invalid || undefined}
                      className="border-t pt-2.5"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span>{t("fields.offboardGraceDays.before")}</span>
                        <Input
                          id="dir-offboard-grace"
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={365}
                          name={field.name}
                          ref={field.ref}
                          value={field.value ?? 0}
                          onBlur={field.onBlur}
                          onChange={(event) =>
                            field.onChange(
                              event.target.value === ""
                                ? 0
                                : event.target.valueAsNumber,
                            )
                          }
                          aria-label={t("fields.offboardGraceDays.label")}
                          className="w-20 text-center font-mono"
                          aria-invalid={fieldState.invalid || undefined}
                        />
                        <span>{t("fields.offboardGraceDays.after")}</span>
                        <HelpTip topic={t("fields.offboardGraceDays.label")}>
                          <p>{t("fields.offboardGraceDays.description")}</p>
                        </HelpTip>
                      </div>
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />
              </div>
            </SettingsSection>
          </form>

          {/* Sync now + the last run. It runs the SAME read-only reconcile the sweeper runs and doubles
              as the bind check — save first, then sync. Deliberately not gated on `enabled`. */}
          <SettingsSection
            title={t("sync.heading")}
            summary={t("sync.summary")}
            help={<p>{t("sync.description")}</p>}
            actions={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onSyncNow}
                disabled={sync.isPending}
              >
                {sync.isPending ? (
                  <ArrowPathIcon className="animate-spin" />
                ) : (
                  <ArrowsRightLeftIcon />
                )}
                {t("sync.button")}
              </Button>
            }
          >
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t("sync.lastRun")}</span>
              <StatusBadge tone={statusTone} dot>
                {t(`sync.status.${data?.lastSyncStatus ?? "never"}`)}
              </StatusBadge>
              {data?.lastSyncAt ? (
                <span className="text-muted-foreground">
                  {date(data.lastSyncAt)}
                </span>
              ) : null}
            </div>
            {data?.lastSyncCounts ? (
              <dl className="grid grid-cols-2 divide-x rounded-lg ring-1 ring-foreground/10 sm:grid-cols-4">
                {(["created", "updated", "offboarded", "skipped"] as const).map(
                  (k) => (
                    <div key={k} className="px-3 py-2">
                      <dt className="text-xs text-muted-foreground">
                        {t(`sync.countLabels.${k}`)}
                      </dt>
                      <dd className="font-mono text-base font-semibold tabular-nums">
                        {data.lastSyncCounts?.[k] ?? 0}
                      </dd>
                    </div>
                  ),
                )}
              </dl>
            ) : null}
          </SettingsSection>
        </>
      )}

      {/* The review tray — directory persons discovered by the sync, for human review. */}
      <DirectoryPendingTray />
    </div>
  );
}
