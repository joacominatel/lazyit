"use client";

import {
  ArrowPathIcon,
  RectangleStackIcon,
  TagIcon,
} from "@heroicons/react/24/outline";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  ASSET_TAG_AFFIX_MAX,
  ASSET_TAG_WIDTH_MAX,
  renderAssetTag,
  type UpdateAssetTagScheme,
  UpdateAssetTagSchemeSchema,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Controller, type Resolver, useForm, useWatch } from "react-hook-form";
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
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  useAssetTagScheme,
  useAssetTagSeedSuggestion,
  useUpdateAssetTagScheme,
} from "@/lib/api/hooks/use-asset-tag-scheme";
import { notifyError } from "@/lib/api/notify-error";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { AssetTagBackfillDialog } from "./asset-tag-backfill-dialog";

/** A blank/absent affix → undefined (for the debounced seed-suggestion key). */
function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Form values shape — deliberately the SAME shape the shared `UpdateAssetTagSchemeSchema` expects, so
 * `zodResolver` validates the live form state directly (it runs over the raw values BEFORE the submit
 * callback). The catch: the schema's affixes are `.trim().min(1).optional()`, so an empty `prefix`/
 * `suffix` must be `undefined`, NOT `""` (a literal "" fails `.min(1)`). The affix inputs therefore
 * write `undefined` for a blank field (see their `onChange`), keeping the state schema-valid at all times.
 * Numbers are `undefined` when the input is empty (= "leave untouched").
 */
type SchemeFormValues = {
  enabled: boolean;
  prefix?: string;
  suffix?: string;
  width?: number;
  startNumber?: number;
};

/** A blank/absent affix → undefined (the schema rejects "", and "no affix" is the absence of the key). */
function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Settings → Instance: the asset-tag scheme editor (ADR-0063 §4, #363). lazyit's first instance-config
 * surface — VIEW + configure + enable the org-wide auto-tag scheme. A `settings:manage` ADMIN defines a
 * `prefix` + zero-padded running number + `suffix`; new assets then get the next tag automatically
 * (OFF by default — toggling `enabled` is the deliberate act). A LIVE PREVIEW renders exactly what the
 * next tag will look like (via the shared, render-identical `renderAssetTag`) as the operator types,
 * before saving.
 *
 * Mounted under the {@link AdminGate} that wraps the whole Instance page, so this only ever renders for
 * a caller who holds `settings:manage`; the API's `@RequirePermission` guard is still the real boundary
 * (a 403 on PUT surfaces as a toast). The form re-seeds from the persisted truth after every save (the
 * recomputed `nextNumber`, the trimmed affixes), so the preview never drifts from what the server stored.
 */
export function AssetTagSchemeEditor() {
  const t = useTranslations("settings.assetTagScheme");
  const { data, isLoading, isError, refetch, isFetching } = useAssetTagScheme();
  const update = useUpdateAssetTagScheme();

  const form = useForm<SchemeFormValues>({
    resolver: zodResolver(UpdateAssetTagSchemeSchema) as Resolver<SchemeFormValues>,
    defaultValues: {
      enabled: false,
      prefix: undefined,
      suffix: undefined,
      width: undefined,
      startNumber: undefined,
    },
  });
  const { control, reset, handleSubmit, formState, setValue } = form;

  // Re-seed the form whenever the server scheme changes (initial load + after every save). `startNumber`
  // is intentionally LEFT BLANK on seed — it's a write-only re-seed input ("start the next tag at N"),
  // not the stored `nextNumber`; pre-filling it would silently rewind the counter on the next save.
  useEffect(() => {
    if (!data) return;
    reset({
      enabled: data.enabled,
      prefix: data.prefix ?? undefined,
      suffix: data.suffix ?? undefined,
      width: data.width ?? undefined,
      startNumber: undefined,
    });
  }, [data, reset]);

  // Live preview: render the tag the NEXT create would get. The number is the operator's `startNumber`
  // when they're (re)seeding, otherwise the server's current `nextNumber`. Rendered with the SAME pure
  // helper the API uses, so the preview is byte-identical to the allocated tag.
  const prefix = useWatch({ control, name: "prefix" });
  const suffix = useWatch({ control, name: "suffix" });
  const width = useWatch({ control, name: "width" });
  const startNumber = useWatch({ control, name: "startNumber" });
  const enabled = useWatch({ control, name: "enabled" });

  const previewNumber =
    startNumber !== undefined && Number.isFinite(startNumber)
      ? startNumber
      : (data?.nextNumber ?? 1);
  const previewTag = renderAssetTag(
    { prefix: emptyToUndefined(prefix), suffix: emptyToUndefined(suffix), width },
    previewNumber,
  );

  const onSubmit = handleSubmit((values) => {
    // `values` is already the schema shape (zodResolver validated it); pass it straight through.
    update.mutate(values as UpdateAssetTagScheme, {
      onSuccess: () => toast.success(t("toast.saved")),
      onError: (error) => notifyError(error, t("toast.saveError")),
    });
  });

  // Seed suggestion (ADR-0068 §2): debounce the pattern the operator is composing, then fetch the
  // suggested `startNumber` = max(existing matching tag) + 1. Surfaced inline; the admin clicks to
  // accept it into the `startNumber` field (never auto-applied). Idle until the scheme is enabled and
  // the affixes settle — the key is the trimmed pattern so it refetches only when that changes.
  const debouncedPrefix = useDebouncedValue(trimToUndefined(prefix), 400);
  const debouncedSuffix = useDebouncedValue(trimToUndefined(suffix), 400);
  const debouncedWidth = useDebouncedValue(width, 400);
  const seed = useAssetTagSeedSuggestion({
    prefix: debouncedPrefix,
    suffix: debouncedSuffix,
    width: debouncedWidth,
    enabled: Boolean(enabled),
  });
  // Only surface the affordance when the suggestion actually advances past where the form would seed.
  const seedData = seed.data;
  const showSeedSuggestion =
    Boolean(enabled) &&
    seedData !== undefined &&
    seedData.matchedCount > 0 &&
    startNumber !== seedData.suggestedStartNumber;

  const [backfillOpen, setBackfillOpen] = useState(false);

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <div className="flex items-center gap-2">
          <TagIcon className="size-5 text-muted-foreground" />
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
            <Button variant="outline" onClick={() => refetch()}>
              <ArrowPathIcon className={isFetching ? "animate-spin" : undefined} />
              {t("retry")}
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} noValidate className="space-y-6">
            <FieldGroup>
              {/* Enabled toggle — the deliberate on/off act (OFF by default). */}
              <Controller
                control={control}
                name="enabled"
                render={({ field }) => (
                  <Field
                    orientation="horizontal"
                    className="rounded-lg border bg-muted/20 p-3"
                  >
                    <div className="flex flex-1 flex-col gap-0.5">
                      <FieldLabel htmlFor="enabled" className="font-medium">
                        {t("fields.enabled.label")}
                      </FieldLabel>
                      <FieldDescription>
                        {t("fields.enabled.description")}
                      </FieldDescription>
                    </div>
                    <Switch
                      id="enabled"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  </Field>
                )}
              />

              {/* Live preview — what the NEXT auto-tag will look like. */}
              <div
                aria-live="polite"
                className="flex items-center justify-between gap-4 rounded-lg border border-primary/20 bg-primary/5 p-3"
              >
                <span className="text-sm font-medium text-muted-foreground">
                  {t("preview.label")}
                </span>
                <code className="rounded bg-background px-2 py-1 font-mono text-sm font-semibold tabular-nums">
                  {previewTag}
                </code>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Controller
                  control={control}
                  name="prefix"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid || undefined}>
                      <FieldLabel htmlFor="prefix">
                        {t("fields.prefix.label")}
                      </FieldLabel>
                      <Input
                        id="prefix"
                        name={field.name}
                        ref={field.ref}
                        value={field.value ?? ""}
                        onBlur={field.onBlur}
                        onChange={(event) =>
                          field.onChange(event.target.value || undefined)
                        }
                        placeholder={t("fields.prefix.placeholder")}
                        maxLength={ASSET_TAG_AFFIX_MAX}
                        className="font-mono"
                        aria-invalid={fieldState.invalid || undefined}
                      />
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />

                <Controller
                  control={control}
                  name="suffix"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid || undefined}>
                      <FieldLabel htmlFor="suffix">
                        {t("fields.suffix.label")}
                      </FieldLabel>
                      <Input
                        id="suffix"
                        name={field.name}
                        ref={field.ref}
                        value={field.value ?? ""}
                        onBlur={field.onBlur}
                        onChange={(event) =>
                          field.onChange(event.target.value || undefined)
                        }
                        placeholder={t("fields.suffix.placeholder")}
                        maxLength={ASSET_TAG_AFFIX_MAX}
                        className="font-mono"
                        aria-invalid={fieldState.invalid || undefined}
                      />
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />

                <Controller
                  control={control}
                  name="width"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid || undefined}>
                      <FieldLabel htmlFor="width">
                        {t("fields.width.label")}
                      </FieldLabel>
                      <Input
                        id="width"
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={ASSET_TAG_WIDTH_MAX}
                        name={field.name}
                        ref={field.ref}
                        value={field.value ?? ""}
                        onBlur={field.onBlur}
                        onChange={(event) =>
                          field.onChange(
                            event.target.value === ""
                              ? undefined
                              : event.target.valueAsNumber,
                          )
                        }
                        placeholder={t("fields.width.placeholder")}
                        aria-invalid={fieldState.invalid || undefined}
                      />
                      <FieldDescription>
                        {t("fields.width.description")}
                      </FieldDescription>
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />

                <Controller
                  control={control}
                  name="startNumber"
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid || undefined}>
                      <FieldLabel htmlFor="startNumber">
                        {t("fields.startNumber.label")}
                      </FieldLabel>
                      <Input
                        id="startNumber"
                        type="number"
                        inputMode="numeric"
                        min={0}
                        name={field.name}
                        ref={field.ref}
                        value={field.value ?? ""}
                        onBlur={field.onBlur}
                        onChange={(event) =>
                          field.onChange(
                            event.target.value === ""
                              ? undefined
                              : event.target.valueAsNumber,
                          )
                        }
                        placeholder={
                          data
                            ? t("fields.startNumber.placeholder", {
                                next: data.nextNumber,
                              })
                            : undefined
                        }
                        aria-invalid={fieldState.invalid || undefined}
                      />
                      <FieldDescription>
                        {t("fields.startNumber.description")}
                      </FieldDescription>
                      <FieldError errors={[fieldState.error]} />
                    </Field>
                  )}
                />
              </div>

              {/* Seed suggestion (ADR-0068 §2) — informational; the admin clicks to accept it into
                  `startNumber`. Only shown when live tags already match the pattern (matchedCount > 0). */}
              {showSeedSuggestion ? (
                <div
                  aria-live="polite"
                  className="flex flex-col gap-2 rounded-lg border border-info/30 bg-info/10 p-3 text-sm text-card-foreground sm:flex-row sm:items-center sm:justify-between"
                >
                  <p className="min-w-0">
                    {t("seedSuggestion.message", {
                      count: seedData.matchedCount,
                      highest:
                        seedData.maxExistingNumber !== null
                          ? renderAssetTag(
                              {
                                prefix: emptyToUndefined(prefix),
                                suffix: emptyToUndefined(suffix),
                                width,
                              },
                              seedData.maxExistingNumber,
                            )
                          : "—",
                      start: seedData.suggestedStartNumber,
                    })}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() =>
                      setValue("startNumber", seedData.suggestedStartNumber, {
                        shouldDirty: true,
                        shouldValidate: true,
                      })
                    }
                  >
                    {t("seedSuggestion.accept", {
                      start: seedData.suggestedStartNumber,
                    })}
                  </Button>
                </div>
              ) : null}

              {!enabled ? (
                <p className="text-sm text-muted-foreground">
                  {t("disabledHint")}
                </p>
              ) : null}
            </FieldGroup>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
              {/* Backfill wizard launch — only when the scheme is enabled (nothing to backfill into a
                  disabled scheme). The dialog is `settings:manage`-gated by the page's AdminGate + API. */}
              {enabled ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setBackfillOpen(true)}
                >
                  <RectangleStackIcon />
                  {t("backfill.launch")}
                </Button>
              ) : (
                <span />
              )}
              <Button
                type="submit"
                disabled={update.isPending || !formState.isDirty}
              >
                {update.isPending && <ArrowPathIcon className="animate-spin" />}
                {t("save")}
              </Button>
            </div>
          </form>
        )}
      </CardContent>

      <AssetTagBackfillDialog
        open={backfillOpen}
        onOpenChange={setBackfillOpen}
      />
    </Card>
  );
}
