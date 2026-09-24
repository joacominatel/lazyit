"use client";

import {
  AI_EFFORT_LEVELS,
  type AiEffort,
  type AiModelCatalog,
} from "@lazyit/shared";
import {
  AdjustmentsHorizontalIcon,
  CheckIcon,
  LockClosedIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useId, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  customModelCandidate,
  filterModels,
  parseTemperature,
  shortModelName,
  supportsTemperature,
  type ChatSettingsDraft,
  type ChatSettingsView,
} from "@/lib/ai/chat-settings";
import { cn } from "@/lib/utils";

const EFFORT_DEFAULT = "default";
const MODEL_DEFAULT = "__default__";

/** Esc inside the popover closes the popover only — never the (non-modal) panel around it. */
function keepEscapeInside(event: KeyboardEvent) {
  if (event.key === "Escape") event.stopPropagation();
}

interface AiChatSettingsProps {
  /** The model catalog; undefined while it loads or when it could not be read (free text only). */
  catalog: AiModelCatalog | undefined;
  catalogLoading: boolean;
  view: ChatSettingsView;
  /** A change is being saved. */
  saving: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Model, effort or temperature changed. */
  onChange: (change: Partial<Omit<ChatSettingsDraft, "autoApprove">>) => void;
  /** The auto-approve switch was flipped (the chat asks for consent before turning it on). */
  onAutoApproveChange: (on: boolean) => void;
}

/**
 * The chat's settings in the composer's toolbar (#1373, #1376): the model — the provider's listed models,
 * the admin's default, or any model id typed in (a custom deployment) —, the reasoning effort where the
 * provider takes one, the temperature where it takes one, and the auto-approve switch. The model fields
 * are pinned once the chat has started (a lock and a note say so); auto-approve can change at any time.
 */
export function AiChatSettings({
  catalog,
  catalogLoading,
  view,
  saving,
  open,
  onOpenChange,
  onChange,
  onAutoApproveChange,
}: AiChatSettingsProps) {
  const t = useTranslations("ai.settings");
  const id = useId();
  const [query, setQuery] = useState("");
  const [temperatureText, setTemperatureText] = useState<string | null>(null);

  const models = catalog?.models ?? [];
  const shown = filterModels(models, query);
  const custom = customModelCandidate(query, models);
  const invalidQuery = query.trim() !== "" && shown.length === 0 && custom === null;
  const runsOn = view.runsOn;
  const buttonName = runsOn ? shortModelName(runsOn) : t("model.defaultShort");

  const temperatureValue = temperatureText ?? (view.temperature === null ? "" : String(view.temperature));
  const temperature = parseTemperature(temperatureValue);

  function pickModel(model: string | null) {
    setQuery("");
    onChange({ model });
  }

  function commitTemperature() {
    if (temperature === "invalid") return;
    setTemperatureText(null);
    if (temperature !== view.temperature) onChange({ temperature });
  }

  function effortDefaultLabel(): string {
    const admin = catalog?.defaultEffort;
    return admin ? t("effort.defaultIs", { level: t(`effort.${admin}`) }) : t("effort.default");
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setQuery("");
          setTemperatureText(null);
        }
        onOpenChange(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="max-w-44 font-mono"
          aria-label={t("open", { model: runsOn ?? t("model.defaultShort") })}
          title={view.locked ? t("model.lockedTitle") : t("open", { model: runsOn ?? t("model.defaultShort") })}
        >
          <AdjustmentsHorizontalIcon />
          <span className="truncate">{buttonName}</span>
          {view.locked && <LockClosedIcon aria-hidden />}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="w-80 space-y-4 p-3"
        onKeyDown={keepEscapeInside}
        aria-label={t("title")}
      >
        <section aria-labelledby={`${id}-model`} className="space-y-1.5">
          <h3 id={`${id}-model`} className="flex items-center gap-1 text-xs font-medium">
            {t("model.label")}
            {view.locked && <LockClosedIcon className="size-3.5 text-muted-foreground" aria-hidden />}
          </h3>
          {view.locked ? (
            <>
              <p className="rounded-sm border border-border bg-muted/50 px-2 py-1.5 font-mono text-xs break-all">
                {runsOn ?? "—"}
              </p>
              <p className="text-xs text-muted-foreground">{t("model.locked")}</p>
            </>
          ) : (
            <>
              <Command shouldFilter={false} className="rounded-md border border-border" label={t("model.label")}>
                <CommandInput
                  value={query}
                  onValueChange={setQuery}
                  placeholder={t("model.search")}
                  className="h-9 font-mono text-xs"
                  disabled={saving}
                  autoFocus
                />
                <CommandList className="max-h-52">
                  {query.trim() === "" && (
                    <CommandGroup>
                      <CommandItem value={MODEL_DEFAULT} onSelect={() => pickModel(null)} disabled={saving}>
                        <CheckIcon className={cn(view.model === null ? "opacity-100" : "opacity-0")} aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block text-xs">{t("model.default")}</span>
                          {catalog && (
                            <span className="block truncate font-mono text-xs text-muted-foreground">
                              {catalog.defaultModel}
                            </span>
                          )}
                        </span>
                      </CommandItem>
                    </CommandGroup>
                  )}
                  {shown.length > 0 && (
                    <CommandGroup heading={t("model.listed")}>
                      {shown.map((m) => (
                        <CommandItem key={m.id} value={m.id} onSelect={() => pickModel(m.id)} disabled={saving}>
                          <CheckIcon className={cn(view.model === m.id ? "opacity-100" : "opacity-0")} aria-hidden />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-mono text-xs">{m.id}</span>
                            {m.label && m.label !== m.id && (
                              <span className="block truncate text-xs text-muted-foreground">{m.label}</span>
                            )}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  )}
                  {custom !== null && (
                    <CommandGroup heading={t("model.customHeading")}>
                      <CommandItem value={`custom:${custom}`} onSelect={() => pickModel(custom)} disabled={saving}>
                        <CheckIcon className={cn(view.model === custom ? "opacity-100" : "opacity-0")} aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-xs">
                          {t("model.useCustom", { id: custom })}
                        </span>
                      </CommandItem>
                    </CommandGroup>
                  )}
                </CommandList>
              </Command>
              {invalidQuery && (
                <p role="alert" className="text-xs text-destructive-text">
                  {t("model.invalid")}
                </p>
              )}
              {catalogLoading ? (
                <p className="text-xs text-muted-foreground">{t("model.loading")}</p>
              ) : !catalog ? (
                <p className="text-xs text-muted-foreground">{t("model.unavailable")}</p>
              ) : !catalog.listed ? (
                <p className="text-xs text-muted-foreground">{t("model.notListed")}</p>
              ) : (
                <p className="text-xs text-muted-foreground">{t("model.hint")}</p>
              )}
            </>
          )}
        </section>

        {catalog?.supportsEffort && (
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-effort`} className="text-xs">
              {t("effort.label")}
            </Label>
            <Select
              value={view.effort ?? EFFORT_DEFAULT}
              disabled={view.locked || saving}
              onValueChange={(value) =>
                onChange({ effort: value === EFFORT_DEFAULT ? null : (value as AiEffort) })
              }
            >
              <SelectTrigger id={`${id}-effort`} size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent onKeyDown={keepEscapeInside}>
                <SelectItem value={EFFORT_DEFAULT}>{effortDefaultLabel()}</SelectItem>
                {AI_EFFORT_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>
                    {t(`effort.${level}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("effort.description")}</p>
          </div>
        )}

        {supportsTemperature(catalog) && (
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-temperature`} className="text-xs">
              {t("temperature.label")}
            </Label>
            <Input
              id={`${id}-temperature`}
              inputMode="decimal"
              value={temperatureValue}
              disabled={view.locked || saving}
              placeholder={t("temperature.placeholder")}
              aria-invalid={temperature === "invalid" || undefined}
              className="h-8 font-mono text-xs tabular-nums"
              onChange={(event) => setTemperatureText(event.target.value)}
              onBlur={commitTemperature}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitTemperature();
                }
              }}
            />
            <p className={cn("text-xs", temperature === "invalid" ? "text-destructive-text" : "text-muted-foreground")}>
              {temperature === "invalid" ? t("temperature.invalid") : t("temperature.description")}
            </p>
          </div>
        )}

        <div className="flex items-start gap-3 border-t border-border pt-3">
          <div className="min-w-0 flex-1">
            <Label htmlFor={`${id}-auto`} className="text-xs">
              {t("auto.label")}
            </Label>
            <p id={`${id}-auto-hint`} className="mt-0.5 text-xs text-muted-foreground">
              {t("auto.description")}
            </p>
          </div>
          <Switch
            id={`${id}-auto`}
            checked={view.autoApprove}
            disabled={saving}
            aria-describedby={`${id}-auto-hint`}
            onCheckedChange={onAutoApproveChange}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
