"use client";

import { AdjustmentsHorizontalIcon, ArrowPathIcon } from "@heroicons/react/24/outline";
import {
  AI_INSTRUCTIONS_MAX_LENGTH,
  AI_RETENTION_DAYS_MAX,
  AI_RETENTION_DAYS_MIN,
  type AiSettings,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
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
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAiConfigSave } from "@/lib/api/hooks/use-ai-config-save";
import { blankToNull, buildUpdate } from "../_lib/ai-settings-form";
import { AiErrorNotice } from "./ai-error-notice";

const INT4_MAX = 2_147_483_647;

/** The editable limits. `dailyTokenLimitPerPrincipal` is null while the budget is off. */
interface LimitsForm {
  retentionDays: number;
  budgetOn: boolean;
  dailyTokenLimitPerPrincipal: number | null;
  approvalTtlMinutes: number;
  maxOutputTokens: number;
  maxStepsPerRun: number;
  contextTokenLimit: number;
  instructions: string;
}

/** An integer in [min, max] — the bounds of `UpdateAiSettingsSchema` (the API re-validates). */
function intWithin(min: number, max: number) {
  return (value: number | null) =>
    value !== null && Number.isInteger(value) && value >= min && value <= max;
}

/** Per-field bounds, mirroring the shared schema. */
const BOUNDS: Record<NumberField, (value: number | null) => boolean> = {
  retentionDays: intWithin(AI_RETENTION_DAYS_MIN, AI_RETENTION_DAYS_MAX),
  approvalTtlMinutes: intWithin(1, INT4_MAX),
  maxOutputTokens: intWithin(1, INT4_MAX),
  maxStepsPerRun: intWithin(1, INT4_MAX),
  contextTokenLimit: intWithin(1, INT4_MAX),
};

type NumberField =
  | "retentionDays"
  | "approvalTtlMinutes"
  | "maxOutputTokens"
  | "maxStepsPerRun"
  | "contextTokenLimit";

function formFrom(settings: AiSettings): LimitsForm {
  return {
    retentionDays: settings.retentionDays,
    budgetOn: settings.dailyTokenLimitPerPrincipal !== null,
    dailyTokenLimitPerPrincipal: settings.dailyTokenLimitPerPrincipal,
    approvalTtlMinutes: settings.approvalTtlMinutes,
    maxOutputTokens: settings.maxOutputTokens,
    maxStepsPerRun: settings.maxStepsPerRun,
    contextTokenLimit: settings.contextTokenLimit,
    instructions: settings.instructions ?? "",
  };
}

/** `valueAsNumber` of a number input; blank / NaN become NaN so the schema reports the field. */
function numberOf(event: React.ChangeEvent<HTMLInputElement>): number {
  return event.target.value === "" ? Number.NaN : event.target.valueAsNumber;
}

/**
 * Settings → AI: the assistant's behaviour and limits — the "extra settings" the CEO asked to keep
 * editable after setup (conversation retention, the per-person daily token budget, how long an
 * approval card stays valid, the output / step / context limits, and the admin's instructions
 * appended to the fixed system prompt). Shown on and off: saving it while the assistant is off keeps
 * it off. The save is the wholesale `PUT`, so the connection and MCP fields are re-sent as read.
 */
export function AiLimitsEditor({ settings }: { settings: AiSettings }) {
  const t = useTranslations("aiSettings.limits");
  const save = useAiConfigSave();
  const form = useForm<LimitsForm>({ defaultValues: formFrom(settings) });
  const { control, reset, handleSubmit, formState } = form;
  const budgetOn = useWatch({ control, name: "budgetOn" });

  // Re-seed only when the LIMITS themselves changed (this card's own save, or another admin's): a save
  // from another card (the MCP switch, the allowlist) must not wipe what is being typed here.
  const limitsKey = JSON.stringify(formFrom(settings));
  useEffect(() => {
    reset(JSON.parse(limitsKey) as LimitsForm);
  }, [limitsKey, reset]);

  // A stale save error goes away as soon as the admin edits again.
  const { clearError } = save;
  const watched = useWatch({ control });
  useEffect(() => {
    clearError();
  }, [watched, clearError]);

  const onSubmit = handleSubmit((values) => {
    save.save(
      buildUpdate(settings, {
        retentionDays: values.retentionDays,
        dailyTokenLimitPerPrincipal: values.budgetOn ? values.dailyTokenLimitPerPrincipal : null,
        approvalTtlMinutes: values.approvalTtlMinutes,
        maxOutputTokens: values.maxOutputTokens,
        maxStepsPerRun: values.maxStepsPerRun,
        contextTokenLimit: values.contextTokenLimit,
        instructions: blankToNull(values.instructions),
      }),
      () => toast.success(t("saved")),
    );
  });

  function numberField(name: NumberField, unit?: string) {
    return (
      <Controller
        control={control}
        name={name}
        rules={{ validate: BOUNDS[name] }}
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid || undefined}>
            <FieldLabel htmlFor={`ai-limit-${name}`}>{t(`fields.${name}.label`)}</FieldLabel>
            <div className="flex items-center gap-2">
              <Input
                id={`ai-limit-${name}`}
                type="number"
                inputMode="numeric"
                min={1}
                name={field.name}
                ref={field.ref}
                value={Number.isNaN(field.value) ? "" : field.value}
                onBlur={field.onBlur}
                onChange={(event) => field.onChange(numberOf(event))}
                aria-invalid={fieldState.invalid || undefined}
                className="font-mono tabular-nums"
              />
              {unit ? <span className="shrink-0 text-sm text-muted-foreground">{unit}</span> : null}
            </div>
            {fieldState.invalid ? (
              <FieldError>{t(`fields.${name}.invalid`)}</FieldError>
            ) : (
              <FieldDescription>{t(`fields.${name}.description`)}</FieldDescription>
            )}
          </Field>
        )}
      />
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <AdjustmentsHorizontalIcon className="size-5 text-muted-foreground" aria-hidden />
          <CardTitle>{t("title")}</CardTitle>
        </div>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            {numberField("retentionDays", t("units.days"))}
            {numberField("approvalTtlMinutes", t("units.minutes"))}
          </div>

          <div className="space-y-3 rounded-lg border p-3">
            <Controller
              control={control}
              name="budgetOn"
              render={({ field }) => (
                <Field orientation="horizontal">
                  <div className="flex flex-1 flex-col gap-0.5">
                    <FieldLabel htmlFor="ai-limit-budget-on" className="font-medium">
                      {t("fields.budget.label")}
                    </FieldLabel>
                    <FieldDescription>{t("fields.budget.description")}</FieldDescription>
                  </div>
                  <Switch
                    id="ai-limit-budget-on"
                    checked={field.value}
                    onCheckedChange={(checked) => {
                      field.onChange(checked);
                      if (checked && form.getValues("dailyTokenLimitPerPrincipal") === null) {
                        form.setValue(
                          "dailyTokenLimitPerPrincipal",
                          settings.dailyTokenLimitPerPrincipal ?? 2_000_000,
                          { shouldDirty: true },
                        );
                      }
                    }}
                  />
                </Field>
              )}
            />
            {budgetOn ? (
              <Controller
                control={control}
                name="dailyTokenLimitPerPrincipal"
                rules={{ validate: intWithin(1, INT4_MAX) }}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid || undefined}>
                    <FieldLabel htmlFor="ai-limit-budget">
                      {t("fields.dailyTokenLimitPerPrincipal.label")}
                    </FieldLabel>
                    <div className="flex items-center gap-2">
                      <Input
                        id="ai-limit-budget"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        name={field.name}
                        ref={field.ref}
                        value={field.value === null || Number.isNaN(field.value) ? "" : field.value}
                        onBlur={field.onBlur}
                        onChange={(event) => {
                          const value = numberOf(event);
                          field.onChange(Number.isNaN(value) ? null : value);
                        }}
                        aria-invalid={fieldState.invalid || undefined}
                        className="font-mono tabular-nums"
                      />
                      <span className="shrink-0 text-sm text-muted-foreground">
                        {t("units.tokensPerDay")}
                      </span>
                    </div>
                    {fieldState.invalid ? (
                      <FieldError>{t("fields.dailyTokenLimitPerPrincipal.invalid")}</FieldError>
                    ) : null}
                  </Field>
                )}
              />
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            {numberField("maxOutputTokens")}
            {numberField("maxStepsPerRun")}
            {numberField("contextTokenLimit")}
          </div>

          <Controller
            control={control}
            name="instructions"
            rules={{ maxLength: AI_INSTRUCTIONS_MAX_LENGTH }}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid || undefined}>
                <FieldLabel htmlFor="ai-limit-instructions">
                  {t("fields.instructions.label")}
                </FieldLabel>
                <Textarea
                  id="ai-limit-instructions"
                  {...field}
                  rows={4}
                  maxLength={AI_INSTRUCTIONS_MAX_LENGTH}
                  placeholder={t("fields.instructions.placeholder")}
                  aria-invalid={fieldState.invalid || undefined}
                />
                <FieldDescription>
                  {t("fields.instructions.description", {
                    count: field.value.length,
                    max: AI_INSTRUCTIONS_MAX_LENGTH,
                  })}
                </FieldDescription>
              </Field>
            )}
          />

          <AiErrorNotice error={save.error} />

          <div className="flex justify-end">
            <Button type="submit" disabled={save.isPending || !formState.isDirty}>
              {save.isPending ? <ArrowPathIcon className="animate-spin" /> : null}
              {t("save")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
