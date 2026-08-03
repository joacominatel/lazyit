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
  useAssetTagNextPreview,
  useAssetTagScheme,
  useAssetTagSeedSuggestion,
  useUpdateAssetTagScheme,
} from "@/lib/api/hooks/use-asset-tag-scheme";
import { notifyError } from "@/lib/api/notify-error";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { AssetTagBackfillDialog } from "./asset-tag-backfill-dialog";
import {
  assetTagPreviewState,
  assetTagShapeParts,
} from "./asset-tag-preview";

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
 * (OFF by default — toggling `enabled` is the deliberate act).
 *
 * The LIVE PREVIEW is a SERVER read (`GET .../next-tag`, #1180), not a local render. The allocator does
 * not hand out the raw counter — it skips forward past any number whose tag is already on a live asset
 * (ADR-0068 §1) — and that lookup needs the estate and is bounded server-side, so the browser cannot
 * reproduce it. Rendering `nextNumber` locally is what made this card claim `IT-1000` while the server
 * allocated `IT-1001`. The preview is not a reservation: nothing is consumed, so a create that lands
 * first still takes the slot and the next preview moves on. With the scheme OFF there is no allocation
 * and therefore no tag to show, so the card renders the pattern's SHAPE instead — never a number, which
 * would be the same lie under a different label. Both decisions live in `./asset-tag-preview`, unit-tested.
 *
 * Mounted under the {@link AdminGate} that wraps the whole Instance page, so this only ever renders for
 * a caller who holds `settings:manage`; the API's `@RequirePermission` guard is still the real boundary
 * (a 403 on PUT surfaces as a toast). The form re-seeds from the persisted truth after every save, and
 * the save invalidates the preview key alongside it.
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

  const prefix = useWatch({ control, name: "prefix" });
  const suffix = useWatch({ control, name: "suffix" });
  const width = useWatch({ control, name: "width" });
  const startNumber = useWatch({ control, name: "startNumber" });
  const enabled = useWatch({ control, name: "enabled" });

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

  // LIVE PREVIEW (#1180) — the tag the next create would actually get, computed by the SERVER.
  //
  // This used to be a local `renderAssetTag(pattern, nextNumber)` call, which was wrong whenever that
  // number's tag was already on a live asset: the card said IT-1000 while the allocator handed out
  // IT-1001. The skip-existing walk needs the live estate and is bounded server-side
  // (`OCCUPIED_SCAN_LIMIT`), so the browser cannot reproduce it — the preview has to be a read.
  //
  // Debounced on the SAME trimmed pattern as the seed suggestion, plus the `startNumber` the operator
  // is typing (a re-seed changes the floor and therefore the answer). `from` is left undefined when
  // the field is blank, which tells the server to use the stored counter — exactly what a create does.
  const debouncedStartNumber = useDebouncedValue(startNumber, 400);
  const previewFrom =
    debouncedStartNumber !== undefined && Number.isFinite(debouncedStartNumber)
      ? debouncedStartNumber
      : undefined;
  const nextPreview = useAssetTagNextPreview({
    prefix: debouncedPrefix,
    suffix: debouncedSuffix,
    width: debouncedWidth,
    from: previewFrom,
    enabled: Boolean(enabled),
  });
  const previewData = nextPreview.data;
  // What the card shows right now (`assetTagPreviewState`, unit-tested next door). Two states matter:
  //
  //  - SCHEME OFF → a shape, never a number. Nothing is allocated with the scheme off, so there is no
  //    next tag; rendering the counter anyway (as this card did, first as "Next tag" and then under a
  //    "Tag shape" label) is the very defect of #1180 — a plausible value nothing will ever assign.
  //    The shape is built from the UNDEBOUNCED fields: it is a pure local render with no request
  //    behind it, so lagging it 400ms would only make it disagree with the inputs.
  //  - LOOKUP FAILED → its own state with a retry. Falling back to the pending copy would leave the
  //    card on "Checking…" indefinitely, indistinguishable from a slow answer and with no way out.
  const previewState = assetTagPreviewState({
    enabled: Boolean(enabled),
    isError: nextPreview.isError,
    data: previewData,
  });
  const shapeParts = assetTagShapeParts({ prefix, suffix, width });
  const previewLabel = enabled ? t("preview.label") : t("preview.disabledLabel");
  // "1000 is taken, so the next free one is 1001" — the one signal that tells a working counter from
  // a broken one. Only meaningful when the walk actually answered and stepped over something.
  const skippedCount =
    previewState.kind === "tag" ? (previewData?.skippedCount ?? 0) : 0;

  const [backfillOpen, setBackfillOpen] = useState(false);

  return (
    <Card>
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

              {/* Live preview — the tag the next create would ACTUALLY get (server-computed, #1180),
                  or, with the scheme off, the pattern's shape: affixes plus a described number slot,
                  with no number anywhere in it. */}
              <div
                aria-live="polite"
                className="flex flex-col gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3"
              >
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm font-medium text-muted-foreground">
                    {previewLabel}
                  </span>
                  {previewState.kind === "tag" ? (
                    <code className="rounded bg-background px-2 py-1 font-mono text-sm font-semibold tabular-nums">
                      {previewState.tag}
                    </code>
                  ) : previewState.kind === "shape" ? (
                    // Affixes verbatim, the number as a DESCRIBED slot ("4 digits") — deliberately
                    // not monospace and not a digit, so the shape cannot be read as a tag.
                    <span className="flex items-center gap-0.5 rounded bg-background px-2 py-1 font-mono text-sm font-semibold">
                      {/* Keyed by position: a prefix and a suffix may be the same string. */}
                      {shapeParts.map((part, index) =>
                        part.kind === "literal" ? (
                          <span key={`literal-${index}`}>{part.text}</span>
                        ) : (
                          <span
                            key={`number-${index}`}
                            className="rounded bg-muted px-1.5 font-sans text-xs font-medium text-muted-foreground"
                          >
                            {t("preview.digits", { count: part.width })}
                          </span>
                        ),
                      )}
                    </span>
                  ) : previewState.kind === "error" ? (
                    <span className="flex items-center gap-2">
                      <span className="text-sm text-destructive">
                        {t("preview.error")}
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void nextPreview.refetch()}
                        disabled={nextPreview.isFetching}
                      >
                        <ArrowPathIcon
                          className={
                            nextPreview.isFetching ? "animate-spin" : undefined
                          }
                        />
                        {t("retry")}
                      </Button>
                    </span>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {previewState.kind === "exhausted"
                        ? t("preview.exhausted")
                        : t("preview.loading")}
                    </span>
                  )}
                </div>
                {skippedCount > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t("preview.skipped", {
                      count: skippedCount,
                      from: previewData?.fromNumber ?? 0,
                    })}
                  </p>
                ) : null}
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
