"use client";

import {
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  CheckBadgeIcon,
  ChevronRightIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import {
  type AiSettings,
  MCP_CLIENT_ALLOWLIST_CURATED_DEFAULTS,
  MCP_CLIENT_ALLOWLIST_MAX_ENTRIES,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { HelpTip } from "@/components/help-tip";
import { SettingRow, SettingsSection } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
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

/** How many built-in clients show as chips before "+N" (the rest are one click away). */
const CHIP_LIMIT = 8;

/**
 * The MCP client allowlist (ADR-0097 decision 13): which OAuth clients may connect. lazyit ships a
 * curated list of the well-known clients (`MCP_CLIENT_ALLOWLIST_CURATED_DEFAULTS`, with how each
 * identifier was verified), and the instance stores only an overlay on it — the admin's own entries and
 * the curated ids the admin removed ("remove" writes the id, "restore" drops it). A client is recognized
 * by its CIMD client-id URL or an exact redirect URI, never by the name it declares. Private-use redirect
 * schemes (`cursor://`, `com.example.app:`) are accepted only on an explicit entry; "any HTTPS client"
 * (on by default, CEO decision) never admits them.
 *
 * Compact (#1540): the built-in clients are chips (✓ when verified); "View details" opens the full list
 * with each identifier, its badges and Remove / Restore. "Clients you added" lists the admin's entries
 * with the add form as one inline row. Every change saves immediately (the wholesale `PUT`).
 */
export function AiMcpAllowlistEditor({ settings }: { settings: AiSettings }) {
  const t = useTranslations("aiSettings.mcp.allowlist");
  const tLinks = useTranslations("aiSettings.links");
  const id = useId();
  const save = useAiConfigSave();
  const [kind, setKind] = useState<AllowlistMatchKind>("redirect_uri");
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<AllowlistValueProblem | null>(null);
  const [showDetails, setShowDetails] = useState(false);

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
  const kept = curated.defaults.filter((d) => !d.removed).map((d) => d.entry);
  const removedCount = curated.defaults.length - kept.length;
  const chips = kept.slice(0, CHIP_LIMIT);
  const hiddenChips = kept.length - chips.length;

  return (
    <SettingsSection
      title={t("title")}
      help={
        <>
          <p>{t("description")}</p>
          <p>{t("notSeeded")}</p>
        </>
      }
      helpHref={tLinks("allowlist")}
    >
      <SettingRow
        label={t("anyHttps.label")}
        htmlFor={`${id}-any`}
        help={<p>{t("anyHttps.description")}</p>}
        helpHref={tLinks("allowlist")}
      >
        <Switch
          id={`${id}-any`}
          checked={settings.mcpAllowAnyHttpsClient}
          disabled={save.isPending}
          onCheckedChange={(checked) =>
            save.save(buildUpdate(settings, { mcpAllowAnyHttpsClient: checked }))
          }
        />
      </SettingRow>

      {/* ── Built-in clients ─────────────────────────────────────────────────────────────── */}
      <div className="space-y-2 border-t pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1 text-sm font-medium">
            {t("builtIn.title")}
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {kept.length}
            </span>
            <HelpTip topic={t("builtIn.title")}>
              <p>{t("builtIn.description")}</p>
            </HelpTip>
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowDetails((v) => !v)}
            aria-expanded={showDetails}
          >
            <ChevronRightIcon
              className={cn("transition-transform", showDetails && "rotate-90")}
              aria-hidden
            />
            {showDetails ? t("builtIn.hideDetails") : t("builtIn.viewDetails")}
          </Button>
        </div>

        {!showDetails ? (
          <ul aria-label={t("builtIn.title")} className="flex flex-wrap gap-1.5">
            {chips.map((entry) => (
              <li
                key={entry.id}
                className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs"
              >
                {entry.verification === "verified" ? (
                  <CheckBadgeIcon
                    className="size-3.5 text-verify"
                    role="img"
                    aria-label={t("verification.verified")}
                  />
                ) : null}
                {entry.label}
              </li>
            ))}
            {hiddenChips > 0 ? (
              <li>
                <button
                  type="button"
                  onClick={() => setShowDetails(true)}
                  className="inline-flex items-center rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={t("builtIn.more", { count: hiddenChips })}
                >
                  +{hiddenChips}
                </button>
              </li>
            ) : null}
            {removedCount > 0 ? (
              <li className="inline-flex items-center px-1 text-xs text-muted-foreground">
                {t("builtIn.removedCount", { count: removedCount })}
              </li>
            ) : null}
          </ul>
        ) : (
          <ul className="divide-y rounded-lg border">
            {curated.defaults.map(({ entry, removed: isRemoved }) => {
              const redirectKind = allowlistEntryRedirectKind(entry);
              return (
                <li
                  key={entry.id}
                  className={cn("flex flex-wrap items-center gap-2 px-3 py-2", isRemoved && "bg-muted/30")}
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
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
        )}
      </div>

      {curated.unknownRemoved.length > 0 ? (
        <div className="space-y-2 border-t pt-3">
          <p className="flex items-center gap-0.5 text-sm font-medium">
            {t("removed.title")}
            <HelpTip topic={t("removed.title")}>
              <p>{t("removed.description")}</p>
            </HelpTip>
          </p>
          <ul className="divide-y rounded-lg border">
            {curated.unknownRemoved.map((defaultId) => (
              <li key={defaultId} className="flex items-center gap-3 px-3 py-2">
                <code className="min-w-0 flex-1 font-mono text-xs break-all">{defaultId}</code>
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

      {/* ── Clients you added ────────────────────────────────────────────────────────────── */}
      <div className="space-y-2 border-t pt-3">
        <p className="flex items-center gap-1 text-sm font-medium">
          {t("added.title")}
          <span className="font-mono text-xs text-muted-foreground tabular-nums">{added.length}</span>
          <HelpTip topic={t("added.title")}>
            <p>{t("add.redirectHint")}</p>
            <p>{t("add.cimdHint")}</p>
          </HelpTip>
        </p>
        {added.length > 0 ? (
          <ul className="divide-y rounded-lg border">
            {added.map((entry) => {
              const redirectKind = allowlistEntryRedirectKind(entry);
              return (
                <li key={entry.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1 space-y-0.5">
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
        ) : null}

        <form onSubmit={onAdd} noValidate aria-label={t("add.title")} className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={`${id}-label`} className="sr-only">
              {t("add.label")}
            </label>
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
              className="h-8 w-full sm:w-40"
            />
            <Select value={kind} onValueChange={(next) => setKind(next as AllowlistMatchKind)}>
              <SelectTrigger
                size="sm"
                aria-label={t("add.kind")}
                className="w-full sm:w-44"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="redirect_uri">{t("kinds.redirect_uri")}</SelectItem>
                <SelectItem value="cimd_url">{t("kinds.cimd_url")}</SelectItem>
              </SelectContent>
            </Select>
            <label htmlFor={`${id}-value`} className="sr-only">
              {kind === "cimd_url" ? t("add.cimdLabel") : t("add.redirectLabel")}
            </label>
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
              className="h-8 min-w-0 flex-1 basis-56 font-mono"
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? `${id}-problem` : undefined}
            />
            <Button type="submit" variant="outline" size="sm" disabled={save.isPending || full}>
              {save.isPending ? <ArrowPathIcon className="animate-spin" /> : <PlusIcon />}
              {t("add.submit")}
            </Button>
          </div>
          {problem ? <FieldError id={`${id}-problem`}>{t(`errors.${problem}`)}</FieldError> : null}
          {full ? (
            <p className="text-sm text-muted-foreground">
              {t("add.full", { max: MCP_CLIENT_ALLOWLIST_MAX_ENTRIES })}
            </p>
          ) : null}
        </form>
      </div>

      <AiErrorNotice error={save.error} />
    </SettingsSection>
  );
}
