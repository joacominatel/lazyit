"use client";

import {
  ArrowPathIcon,
  ArrowsRightLeftIcon,
  ServerStackIcon,
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

/** Default attribute-name suggestions for a typical Active Directory (only placeholders, not values). */
const AD_ATTR_PLACEHOLDER: Record<string, string> = {
  firstName: "givenName",
  lastName: "sn",
  email: "mail",
  username: "sAMAccountName",
};

/**
 * Settings → Instance: the AD/LDAP directory-source editor (issue #839, ADR-0091). A `settings:manage`
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
  const { control, reset, handleSubmit } = form;

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

  const enabled = useWatch({ control, name: "enabled" });
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

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ServerStackIcon className="size-5 text-muted-foreground" />
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
            <p className="text-sm text-muted-foreground">{t("loadErrorHint")}</p>
            <RequestIdNote requestId={requestId} />
            <Button variant="outline" onClick={() => refetch()}>
              <ArrowPathIcon className={isFetching ? "animate-spin" : undefined} />
              {t("retry")}
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} noValidate className="space-y-6">
            <FieldGroup>
              {/* Enabled toggle — the master on/off for the scheduled sweeper (Sync now works while off). */}
              <Controller
                control={control}
                name="enabled"
                render={({ field }) => (
                  <Field
                    orientation="horizontal"
                    className="rounded-lg border bg-muted/20 p-3"
                  >
                    <div className="flex flex-1 flex-col gap-0.5">
                      <FieldLabel htmlFor="dir-enabled" className="font-medium">
                        {t("fields.enabled.label")}
                      </FieldLabel>
                      <FieldDescription>
                        {t("fields.enabled.description")}
                      </FieldDescription>
                    </div>
                    <Switch
                      id="dir-enabled"
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
                      <FieldLabel htmlFor="dir-host">
                        {t("fields.host.label")}
                      </FieldLabel>
                      <Input
                        id="dir-host"
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
                    <FieldLabel htmlFor="dir-transport">
                      {t("fields.transport.label")}
                    </FieldLabel>
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
                    <FieldDescription>
                      {t(`fields.transport.hint.${field.value}`)}
                    </FieldDescription>
                  </Field>
                )}
              />

              {/* TLS cert verification — a secure default (on); off allows a self-signed internal cert.
                  Inert under plaintext (no TLS to verify), so the control is disabled + hint swapped. */}
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
                        htmlFor="dir-reject-unauthorized"
                        className="font-medium"
                      >
                        {t("fields.rejectUnauthorized.label")}
                      </FieldLabel>
                      <FieldDescription>
                        {transport === "plaintext"
                          ? t("fields.rejectUnauthorized.plaintextHint")
                          : t("fields.rejectUnauthorized.description")}
                      </FieldDescription>
                    </div>
                    <Switch
                      id="dir-reject-unauthorized"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      disabled={transport === "plaintext"}
                    />
                  </Field>
                )}
              />

              <Controller
                control={control}
                name="baseDN"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel htmlFor="dir-base-dn">
                      {t("fields.baseDN.label")}
                    </FieldLabel>
                    <Input
                      id="dir-base-dn"
                      name={field.name}
                      ref={field.ref}
                      value={field.value ?? ""}
                      onBlur={field.onBlur}
                      onChange={(event) =>
                        field.onChange(emptyToNull(event.target.value))
                      }
                      placeholder={t("fields.baseDN.placeholder")}
                      autoComplete="off"
                      aria-invalid={fieldState.invalid || undefined}
                    />
                    <FieldDescription>
                      {t("fields.baseDN.description")}
                    </FieldDescription>
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />

              <Controller
                control={control}
                name="bindDN"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel htmlFor="dir-bind-dn">
                      {t("fields.bindDN.label")}
                    </FieldLabel>
                    <Input
                      id="dir-bind-dn"
                      name={field.name}
                      ref={field.ref}
                      value={field.value ?? ""}
                      onBlur={field.onBlur}
                      onChange={(event) =>
                        field.onChange(emptyToNull(event.target.value))
                      }
                      placeholder={t("fields.bindDN.placeholder")}
                      autoComplete="off"
                      aria-invalid={fieldState.invalid || undefined}
                    />
                    <FieldDescription>
                      {t("fields.bindDN.description")}
                    </FieldDescription>
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />

              <Controller
                control={control}
                name="bindPassword"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel htmlFor="dir-bind-password">
                      {t("fields.bindPassword.label")}
                    </FieldLabel>
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
                    {data?.bindPasswordSet ? (
                      <FieldDescription>
                        {t("fields.bindPassword.hintSet")}
                      </FieldDescription>
                    ) : null}
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />

              <Controller
                control={control}
                name="searchFilter"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel htmlFor="dir-search-filter">
                      {t("fields.searchFilter.label")}
                    </FieldLabel>
                    <Input
                      id="dir-search-filter"
                      name={field.name}
                      ref={field.ref}
                      value={field.value ?? ""}
                      onBlur={field.onBlur}
                      onChange={(event) =>
                        field.onChange(emptyToNull(event.target.value))
                      }
                      placeholder={t("fields.searchFilter.placeholder")}
                      autoComplete="off"
                      className="font-mono text-sm"
                      aria-invalid={fieldState.invalid || undefined}
                    />
                    <FieldDescription>
                      {t("fields.searchFilter.description")}
                    </FieldDescription>
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />

              <Controller
                control={control}
                name="offboardGraceDays"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel htmlFor="dir-offboard-grace">
                      {t("fields.offboardGraceDays.label")}
                    </FieldLabel>
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
                      className="max-w-32"
                      aria-invalid={fieldState.invalid || undefined}
                    />
                    <FieldDescription>
                      {t("fields.offboardGraceDays.description")}
                    </FieldDescription>
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />

              {/* Attribute map — the four recognized profile keys → AD attribute NAMES. Local state (see
                  directory-form.ts): assembled into the wire `attributeMap` at submit. */}
              <div className="space-y-3 rounded-lg border bg-muted/20 p-3">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">
                    {t("fields.attributeMap.label")}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t("fields.attributeMap.description")}
                  </p>
                </div>
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

              {!enabled ? (
                <p className="text-sm text-muted-foreground">
                  {t("disabledHint")}
                </p>
              ) : null}
            </FieldGroup>

            <div className="flex justify-end">
              {/* Save re-seeds the form after every save, so the attribute inputs never drift from storage.
                  Not gated on `formState.isDirty` alone — the attribute inputs live outside RHF, so a
                  mapping-only edit must still be saveable. */}
              <Button type="submit" disabled={update.isPending}>
                {update.isPending && <ArrowPathIcon className="animate-spin" />}
                {t("save")}
              </Button>
            </div>

            {/* Sync now + last-run result panel. "Sync now" runs the SAME read-only reconcile the sweeper
                runs and doubles as the bind/connectivity check — save first, then sync. */}
            <div className="space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">{t("sync.heading")}</p>
                  <p className="text-sm text-muted-foreground">
                    {t("sync.description")}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0 bg-background"
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
              </div>

              {/* Cached last-run outcome (from the persisted row). Renders once a run has happened. */}
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">
                  {t("sync.lastRun")}
                </span>
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
                <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {(
                    ["created", "updated", "offboarded", "skipped"] as const
                  ).map((k) => (
                    <div
                      key={k}
                      className="rounded-md border bg-background p-2 text-center"
                    >
                      <dt className="text-xs text-muted-foreground">
                        {t(`sync.countLabels.${k}`)}
                      </dt>
                      <dd className="text-base font-semibold tabular-nums">
                        {data.lastSyncCounts?.[k] ?? 0}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>
          </form>
        )}

        {/* The PENDING review tray — directory persons discovered by the sync, for human review. */}
        <DirectoryPendingTray />
      </CardContent>
    </Card>
  );
}
