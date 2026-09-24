"use client";

import { KeyIcon } from "@heroicons/react/24/outline";
import {
  AI_EFFORT_LEVELS,
  AI_PROVIDER_DESCRIPTORS,
  AI_PROVIDER_KINDS,
  type AiEffort,
  type AiProviderKind,
  type AiSettings,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useEffect, useId } from "react";
import { Callout } from "@/components/callout";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAiModelSuggestions } from "@/lib/api/hooks/use-ai-config";
import { cn } from "@/lib/utils";
import {
  baseUrlProblem,
  type ConnectionDraft,
  keyFieldState,
  parseTemperature,
} from "../_lib/ai-settings-form";

/** The select's value for "the provider's default effort" (Radix Select has no empty value). */
const EFFORT_DEFAULT = "default";

/**
 * The provider picker: one radio card per shared descriptor (the descriptors drive the wizard, so a
 * provider added to `@lazyit/shared` appears here with no web change beyond its description copy).
 * Brand names are data and are not translated.
 */
export function AiProviderPicker({
  value,
  onChange,
}: {
  value: AiProviderKind;
  onChange: (provider: AiProviderKind) => void;
}) {
  const t = useTranslations("aiSettings.provider");
  const baseId = useId();
  return (
    <RadioGroup
      value={value}
      onValueChange={(next) => onChange(next as AiProviderKind)}
      aria-label={t("label")}
      className="grid gap-3 sm:grid-cols-2"
    >
      {AI_PROVIDER_KINDS.map((kind) => {
        const id = `${baseId}-${kind}`;
        const selected = value === kind;
        return (
          <label
            key={kind}
            htmlFor={id}
            className={cn(
              "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/40",
              selected && "border-primary bg-muted/30",
            )}
          >
            <RadioGroupItem value={kind} id={id} className="mt-0.5" />
            <span className="space-y-1">
              <span className="block text-sm font-medium">
                {AI_PROVIDER_DESCRIPTORS[kind].label}
              </span>
              <span className="block text-sm text-muted-foreground">
                {t(`descriptions.${kind}`)}
              </span>
            </span>
          </label>
        );
      })}
    </RadioGroup>
  );
}

/**
 * Credentials for the draft provider: the API key (write-only — never pre-filled, never shown back),
 * and for the OpenAI-compatible provider the base URL and the private-network option. When the server
 * has no usable `AI_SECRET_KEY`, the field says so before the save answers 409.
 */
export function AiCredentialsFields({
  settings,
  draft,
  onChange,
}: {
  settings: AiSettings;
  draft: ConnectionDraft;
  onChange: (patch: Partial<ConnectionDraft>) => void;
}) {
  const t = useTranslations("aiSettings.credentials");
  const id = useId();
  const descriptor = AI_PROVIDER_DESCRIPTORS[draft.provider];
  const compatible = draft.provider === "openai-compatible";
  const baseUrl = compatible ? draft.baseUrl.trim() || null : null;
  const keyState = keyFieldState(settings, draft.provider, baseUrl);
  const urlProblem = compatible
    ? baseUrlProblem(draft.baseUrl, draft.provider, draft.allowPrivateNetwork)
    : null;
  const needsSecretKey =
    !settings.keyConfigured &&
    (descriptor.requiresApiKey || draft.apiKey.trim() !== "");

  return (
    <div className="space-y-4">
      {compatible ? (
        <>
          <Field data-invalid={urlProblem && draft.baseUrl ? true : undefined}>
            <FieldLabel htmlFor={`${id}-base-url`}>{t("baseUrl.label")}</FieldLabel>
            <Input
              id={`${id}-base-url`}
              value={draft.baseUrl}
              onChange={(event) => onChange({ baseUrl: event.target.value })}
              placeholder={t("baseUrl.placeholder")}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              aria-invalid={urlProblem && draft.baseUrl ? true : undefined}
            />
            <FieldDescription>{t("baseUrl.description")}</FieldDescription>
            {urlProblem && draft.baseUrl ? (
              <FieldError>{t(`baseUrl.problems.${urlProblem}`)}</FieldError>
            ) : null}
          </Field>
          <Field orientation="horizontal" className="rounded-lg border bg-muted/20 p-3">
            <div className="flex flex-1 flex-col gap-0.5">
              <FieldLabel htmlFor={`${id}-private`} className="font-medium">
                {t("privateNetwork.label")}
              </FieldLabel>
              <FieldDescription>{t("privateNetwork.description")}</FieldDescription>
            </div>
            <Switch
              id={`${id}-private`}
              checked={draft.allowPrivateNetwork}
              onCheckedChange={(checked) => onChange({ allowPrivateNetwork: checked })}
            />
          </Field>
        </>
      ) : null}

      <Field>
        <FieldLabel htmlFor={`${id}-key`}>
          {t("apiKey.label", { provider: descriptor.label })}
        </FieldLabel>
        <Input
          id={`${id}-key`}
          type="password"
          value={draft.apiKey}
          onChange={(event) => onChange({ apiKey: event.target.value })}
          placeholder={
            keyState === "keep"
              ? t("apiKey.placeholderKeep")
              : keyState === "required"
                ? t("apiKey.placeholderRequired")
                : t("apiKey.placeholderOptional")
          }
          autoComplete="new-password"
          spellCheck={false}
        />
        <FieldDescription>
          {keyState === "keep"
            ? t("apiKey.hintKeep")
            : settings.apiKeySet
              ? t("apiKey.hintReplaced")
              : keyState === "required"
                ? t("apiKey.hintRequired")
                : t("apiKey.hintOptional")}{" "}
          {t("apiKey.writeOnly")}
        </FieldDescription>
      </Field>

      {needsSecretKey ? (
        <Callout tone="warning" icon={<KeyIcon />}>
          <p className="text-sm">{t("secretKeyMissing")}</p>
        </Callout>
      ) : null}
    </div>
  );
}

/**
 * The model (free text with the provider's suggestions) and the per-provider extras: the reasoning
 * effort, and a temperature for the OpenAI-compatible provider only (the hosted models reject it).
 */
export function AiModelFields({
  draft,
  onChange,
}: {
  draft: ConnectionDraft;
  onChange: (patch: Partial<ConnectionDraft>) => void;
}) {
  const t = useTranslations("aiSettings.model");
  const id = useId();
  const suggestions = useAiModelSuggestions();
  const { mutate } = suggestions;
  const provider = draft.provider;

  // Suggestions follow the draft provider; a failure only leaves the list empty (free text is allowed).
  useEffect(() => {
    mutate({ provider });
  }, [mutate, provider]);

  const temperature = parseTemperature(draft.temperature);
  const temperatureInvalid = temperature !== undefined && Number.isNaN(temperature);
  const models = suggestions.data?.models ?? [];

  return (
    <div className="space-y-4">
      <Field>
        <FieldLabel htmlFor={`${id}-model`}>{t("label")}</FieldLabel>
        <Input
          id={`${id}-model`}
          value={draft.model}
          onChange={(event) => onChange({ model: event.target.value })}
          list={`${id}-models`}
          placeholder={t("placeholder")}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
        />
        <datalist id={`${id}-models`}>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label ?? model.id}
            </option>
          ))}
        </datalist>
        <FieldDescription>{t("description")}</FieldDescription>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor={`${id}-effort`}>{t("effort.label")}</FieldLabel>
          <Select
            value={draft.effort ?? EFFORT_DEFAULT}
            onValueChange={(value) =>
              onChange({
                effort: value === EFFORT_DEFAULT ? null : (value as AiEffort),
              })
            }
          >
            <SelectTrigger id={`${id}-effort`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={EFFORT_DEFAULT}>{t("effort.default")}</SelectItem>
              {AI_EFFORT_LEVELS.map((level) => (
                <SelectItem key={level} value={level}>
                  {t(`effort.${level}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>{t("effort.description")}</FieldDescription>
        </Field>

        {provider === "openai-compatible" ? (
          <Field data-invalid={temperatureInvalid || undefined}>
            <FieldLabel htmlFor={`${id}-temperature`}>
              {t("temperature.label")}
            </FieldLabel>
            <Input
              id={`${id}-temperature`}
              inputMode="decimal"
              value={draft.temperature}
              onChange={(event) => onChange({ temperature: event.target.value })}
              placeholder={t("temperature.placeholder")}
              aria-invalid={temperatureInvalid || undefined}
              className="font-mono tabular-nums"
            />
            {temperatureInvalid ? (
              <FieldError>{t("temperature.invalid")}</FieldError>
            ) : (
              <FieldDescription>{t("temperature.description")}</FieldDescription>
            )}
          </Field>
        ) : null}
      </div>
    </div>
  );
}

/** Whether the draft can be saved as far as the web can tell (the API re-checks everything). */
export function isDraftSavable(
  settings: AiSettings,
  draft: ConnectionDraft,
  opts: { requireModel: boolean },
): boolean {
  const compatible = draft.provider === "openai-compatible";
  if (compatible && baseUrlProblem(draft.baseUrl, draft.provider, draft.allowPrivateNetwork)) {
    return false;
  }
  const baseUrl = compatible ? draft.baseUrl.trim() || null : null;
  if (
    keyFieldState(settings, draft.provider, baseUrl) === "required" &&
    draft.apiKey.trim() === ""
  ) {
    return false;
  }
  const temperature = parseTemperature(draft.temperature);
  if (temperature !== undefined && Number.isNaN(temperature)) return false;
  return !opts.requireModel || draft.model.trim() !== "";
}
