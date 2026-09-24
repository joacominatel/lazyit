"use client";

import { ArrowPathIcon, PlusIcon, TrashIcon, ArrowUturnLeftIcon } from "@heroicons/react/24/outline";
import {
  type AiSettings,
  MCP_CLIENT_ALLOWLIST_CURATED_DEFAULTS,
  MCP_CLIENT_ALLOWLIST_MAX_ENTRIES,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
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
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useAiConfigSave } from "@/lib/api/hooks/use-ai-config-save";
import { cn } from "@/lib/utils";
import {
  allowlistEntryRedirectKind,
  allowlistEntryValue,
  type AllowlistMatchKind,
  type AllowlistValueProblem,
  buildAllowlistEntry,
  buildUpdate,
  curatedAllowlistView,
  toggleRemovedDefault,
} from "../_lib/ai-settings-form";
import { AiErrorNotice } from "./ai-error-notice";

/**
 * The MCP client allowlist (ADR-0097 decision 13): which OAuth clients may connect. lazyit ships a
 * curated list of the well-known clients (`MCP_CLIENT_ALLOWLIST_CURATED_DEFAULTS`, listed here with how
 * each identifier was verified), and the instance stores only an overlay on it — the admin's own
 * entries and the curated ids the admin removed ("remove" writes the id, "restore" drops it). A client is recognized by its CIMD client-id URL
 * or an exact redirect URI, never by the name it declares. Private-use redirect schemes (`cursor://`,
 * `com.example.app:`) are accepted only on an explicit entry; "any HTTPS client" (on by default, CEO
 * decision) never admits them.
 *
 * Every change saves immediately (the wholesale `PUT`, the rest re-sent as read).
 */
export function AiMcpAllowlistEditor({ settings }: { settings: AiSettings }) {
  const t = useTranslations("aiSettings.mcp.allowlist");
  const id = useId();
  const save = useAiConfigSave();
  const [kind, setKind] = useState<AllowlistMatchKind>("redirect_uri");
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<AllowlistValueProblem | null>(null);

  const added = settings.mcpClientAllowlistAdded;
  const removed = settings.mcpClientAllowlistRemovedDefaults;
  const full = added.length >= MCP_CLIENT_ALLOWLIST_MAX_ENTRIES;

  function onAdd(event: React.FormEvent) {
    event.preventDefault();
    const built = buildAllowlistEntry(kind, label, value, added);
    if ("problem" in built) {
      setProblem(built.problem);
      return;
    }
    setProblem(null);
    save.save(
      buildUpdate(settings, { mcpClientAllowlistAdded: [...added, built.entry] }),
      () => {
        setLabel("");
        setValue("");
        toast.success(t("addedToast", { label: built.entry.label }));
      },
    );
  }

  function onRemove(entryId: string) {
    save.save(
      buildUpdate(settings, {
        mcpClientAllowlistAdded: added.filter((entry) => entry.id !== entryId),
      }),
    );
  }

  /** Remove (`true`) or restore (`false`) one built-in client: its id in the removed-defaults overlay. */
  function setDefaultRemoved(defaultId: string, remove: boolean) {
    save.save(
      buildUpdate(settings, {
        mcpClientAllowlistRemovedDefaults: toggleRemovedDefault(removed, defaultId, remove),
      }),
    );
  }

  const curated = curatedAllowlistView(MCP_CLIENT_ALLOWLIST_CURATED_DEFAULTS, removed);

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("title")}</p>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
        <p className="text-sm text-muted-foreground">{t("notSeeded")}</p>
      </div>

      <Field orientation="horizontal" className="rounded-lg border bg-muted/20 p-3">
        <div className="flex flex-1 flex-col gap-0.5">
          <FieldLabel htmlFor={`${id}-any`} className="font-medium">
            {t("anyHttps.label")}
          </FieldLabel>
          <FieldDescription>{t("anyHttps.description")}</FieldDescription>
        </div>
        <Switch
          id={`${id}-any`}
          checked={settings.mcpAllowAnyHttpsClient}
          disabled={save.isPending}
          onCheckedChange={(checked) =>
            save.save(buildUpdate(settings, { mcpAllowAnyHttpsClient: checked }))
          }
        />
      </Field>

      <div className="space-y-2">
        <p className="text-sm font-medium">{t("builtIn.title")}</p>
        <p className="text-sm text-muted-foreground">{t("builtIn.description")}</p>
        <ul className="divide-y rounded-lg border">
          {curated.defaults.map(({ entry, removed: isRemoved }) => {
            const redirectKind = allowlistEntryRedirectKind(entry);
            return (
              <li
                key={entry.id}
                className={cn("flex flex-wrap items-center gap-3 p-3", isRemoved && "bg-muted/30")}
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <p
                    className={cn(
                      "text-sm font-medium",
                      isRemoved && "text-muted-foreground line-through",
                    )}
                  >
                    {entry.label}
                  </p>
                  <p className="font-mono text-xs break-all text-muted-foreground">
                    {allowlistEntryValue(entry)}
                  </p>
                </div>
                <StatusBadge
                  tone={entry.verification === "verified" ? "success" : "neutral"}
                  title={entry.source}
                >
                  {t(`verification.${entry.verification}`)}
                </StatusBadge>
                <StatusBadge tone="neutral">
                  {entry.match.kind === "cimd_url"
                    ? t("kinds.cimd_url")
                    : t(`redirectKinds.${redirectKind ?? "https"}`)}
                </StatusBadge>
                {isRemoved ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setDefaultRemoved(entry.id, false)}
                    disabled={save.isPending}
                    aria-label={t("builtIn.restoreAria", { label: entry.label })}
                  >
                    <ArrowUturnLeftIcon />
                    {t("builtIn.restore")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setDefaultRemoved(entry.id, true)}
                    disabled={save.isPending}
                    aria-label={t("builtIn.remove", { label: entry.label })}
                  >
                    <TrashIcon />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">{t("added.title")}</p>
        {added.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("added.empty")}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {added.map((entry) => {
              const redirectKind = allowlistEntryRedirectKind(entry);
              return (
                <li key={entry.id} className="flex flex-wrap items-center gap-3 p-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-sm font-medium">{entry.label}</p>
                    <p className="font-mono text-xs break-all text-muted-foreground">
                      {allowlistEntryValue(entry)}
                    </p>
                  </div>
                  <StatusBadge tone="neutral">
                    {entry.match.kind === "cimd_url"
                      ? t("kinds.cimd_url")
                      : t(`redirectKinds.${redirectKind ?? "https"}`)}
                  </StatusBadge>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onRemove(entry.id)}
                    disabled={save.isPending}
                    aria-label={t("added.remove", { label: entry.label })}
                  >
                    <TrashIcon />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {curated.unknownRemoved.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("removed.title")}</p>
          <p className="text-sm text-muted-foreground">{t("removed.description")}</p>
          <ul className="divide-y rounded-lg border">
            {curated.unknownRemoved.map((defaultId) => (
              <li key={defaultId} className="flex items-center gap-3 p-3">
                <code className="flex-1 font-mono text-xs">{defaultId}</code>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setDefaultRemoved(defaultId, false)}
                  disabled={save.isPending}
                >
                  <ArrowUturnLeftIcon />
                  {t("removed.restore")}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <form onSubmit={onAdd} noValidate className="space-y-3 rounded-lg border p-3">
        <p className="text-sm font-medium">{t("add.title")}</p>
        <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
          <Field>
            <FieldLabel htmlFor={`${id}-label`}>{t("add.label")}</FieldLabel>
            <Input
              id={`${id}-label`}
              value={label}
              maxLength={120}
              onChange={(event) => {
                setLabel(event.target.value);
                save.clearError();
              }}
              placeholder={t("add.labelPlaceholder")}
              autoComplete="off"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-kind`}>{t("add.kind")}</FieldLabel>
            <Select value={kind} onValueChange={(next) => setKind(next as AllowlistMatchKind)}>
              <SelectTrigger id={`${id}-kind`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="redirect_uri">{t("kinds.redirect_uri")}</SelectItem>
                <SelectItem value="cimd_url">{t("kinds.cimd_url")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field data-invalid={problem ? true : undefined}>
          <FieldLabel htmlFor={`${id}-value`}>
            {kind === "cimd_url" ? t("add.cimdLabel") : t("add.redirectLabel")}
          </FieldLabel>
          <Input
            id={`${id}-value`}
            value={value}
            maxLength={2048}
            onChange={(event) => {
              setValue(event.target.value);
              setProblem(null);
              save.clearError();
            }}
            placeholder={
              kind === "cimd_url" ? t("add.cimdPlaceholder") : t("add.redirectPlaceholder")
            }
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            aria-invalid={problem ? true : undefined}
          />
          {problem ? (
            <FieldError>{t(`errors.${problem}`)}</FieldError>
          ) : (
            <FieldDescription>
              {kind === "cimd_url" ? t("add.cimdHint") : t("add.redirectHint")}
            </FieldDescription>
          )}
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="outline" disabled={save.isPending || full}>
            {save.isPending ? <ArrowPathIcon className="animate-spin" /> : <PlusIcon />}
            {t("add.submit")}
          </Button>
        </div>
        {full ? (
          <p className="text-sm text-muted-foreground">
            {t("add.full", { max: MCP_CLIENT_ALLOWLIST_MAX_ENTRIES })}
          </p>
        ) : null}
      </form>

      <AiErrorNotice error={save.error} />
    </div>
  );
}
