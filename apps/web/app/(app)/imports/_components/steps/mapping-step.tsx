"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import {
  AssetStatusSchema,
  IMPORT_UI_TARGETS,
  assetImportDescriptor,
  type ColumnFieldMapping,
  type CustomFieldMapping,
  type EnumValueMapping,
  type FkFieldMapping,
  type ImportMapping,
  type ImportSessionView,
  type ModelConfig,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useRunImportDryRun,
  useSetImportMapping,
} from "@/lib/api/hooks/use-imports";
import type { ImportDryRunReport } from "@lazyit/shared";
import { useImportError } from "../use-import-error";

/**
 * Step 3 — Mapping (ADR-0069 REDESIGN §6.2). COLUMN-CENTRIC + assisted: one card per CSV column, not
 * one per lazyit field. The operator sees their real columns (the de-duped renamed headers, e.g.
 * `Dirección (2)`) with example values, and for each picks where it goes — a lazyit field (grouped by
 * Asset / Model), a brand-new custom field saved to the asset's `specs`, or "Ignore" (the default for
 * empty/irrelevant columns). The mapping is auto-SEEDED per column (best-matching field) but the
 * operator always confirms; nothing is dropped silently.
 *
 * Every header used here is the RENAMED form end-to-end (§4.1): `session.headers`, the keys of
 * `session.samples` and `row.raw`, the status value-map and the built `ImportMapping` all share it.
 *
 * On submit: `POST mapping` (→ MAPPED) then `POST dry-run` (→ the report), handed up to the preview
 * step. `onMapped`/`onBack` and the `setMapping → dryRun` flow are unchanged.
 */

/** Target token: where a column's value goes. `__ignore__` drops it, `__custom__` → specs, else `entity:field`. */
const IGNORE = "__ignore__";
const CUSTOM = "__custom__";

/** Build the `entity:field` token used as a column's Select value (e.g. `asset:name`, `model:category`). */
function token(entity: string, field: string): string {
  return `${entity}:${field}`;
}

/** FK fields per the descriptor (`modelId`, `locationId`) — they route to `references`, not `columns`. */
const FK_FIELDS = new Set(Object.keys(assetImportDescriptor.references));

/** Normalize a header / field for fuzzy auto-suggest (case-fold, strip non-alphanumerics). */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Per-column state: the chosen target token + (for `__custom__`) the operator-named specs key. */
type ColumnChoice = { target: string; customName: string };

export function MappingStep({
  sessionId,
  session,
  onBack,
  onMapped,
}: {
  sessionId: string;
  session: ImportSessionView;
  onBack: () => void;
  onMapped: (report: ImportDryRunReport) => void;
}) {
  const t = useTranslations("imports");
  const { notify } = useImportError();
  const setMapping = useSetImportMapping();
  const dryRun = useRunImportDryRun();

  const headers = session.headers;

  // i18n leaf-label for a field (the catalog carries a shared key like "import.asset.field.name";
  // we render the last segment under our own `mapping.field.*` namespace).
  const fieldLabel = (i18nKey: string): string => {
    const leaf = i18nKey.split(".").pop() ?? i18nKey;
    return t(`mapping.field.${leaf}` as Parameters<typeof t>[0]);
  };

  // The label shown on the trigger / summary badge for a chosen target token.
  const targetLabel = useMemo(() => {
    const byToken = new Map<string, string>();
    for (const f of IMPORT_UI_TARGETS.asset) byToken.set(token("asset", f.field), fieldLabel(f.i18nKey));
    for (const f of IMPORT_UI_TARGETS.model) byToken.set(token("model", f.field), fieldLabel(f.i18nKey));
    return (target: string): string => byToken.get(target) ?? target;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Per-column example values: prefer backend samples, else derive locally from the materialized rows.
  const samplesByHeader = useMemo<Record<string, string[]>>(() => {
    const out: Record<string, string[]> = {};
    for (const h of headers) {
      const fromBackend = session.samples?.[h];
      if (fromBackend && fromBackend.length > 0) {
        out[h] = fromBackend.slice(0, 4);
        continue;
      }
      const seen = new Set<string>();
      for (const row of session.rows) {
        const raw = row.raw[h];
        if (raw && raw.trim()) seen.add(raw.trim());
        if (seen.size >= 4) break;
      }
      out[h] = [...seen];
    }
    return out;
  }, [headers, session.samples, session.rows]);

  // --- per-column seed: the single best target for each column (suggestion only, operator confirms) ---
  // A field is claimed by at most one column (first/best wins) so two columns don't both grab `name`.
  const initialChoices = useMemo<Record<string, ColumnChoice>>(() => {
    const out: Record<string, ColumnChoice> = {};
    const claimed = new Set<string>();
    const candidates: { entity: "asset" | "model"; field: string }[] = [
      ...IMPORT_UI_TARGETS.asset.map((f) => ({ entity: "asset" as const, field: f.field })),
      ...IMPORT_UI_TARGETS.model.map((f) => ({ entity: "model" as const, field: f.field })),
    ];
    for (const h of headers) {
      const norm = normalize(h);
      const match = candidates.find(
        (c) => !claimed.has(token(c.entity, c.field)) && normalize(c.field) === norm,
      );
      if (match) {
        const tok = token(match.entity, match.field);
        claimed.add(tok);
        out[h] = { target: tok, customName: "" };
      } else {
        out[h] = { target: IGNORE, customName: "" };
      }
    }
    return out;
  }, [headers]);

  const [choices, setChoices] = useState(initialChoices);

  function setChoice(header: string, patch: Partial<ColumnChoice>) {
    setChoices((prev) => ({ ...prev, [header]: { ...prev[header], ...patch } }));
  }

  // The header (if any) the operator mapped to `status` — its value-map lives inside that column's card.
  const statusHeader = useMemo(
    () => headers.find((h) => choices[h]?.target === token("asset", "status")) ?? null,
    [headers, choices],
  );

  // --- status value-map: one row per distinct raw value in the status column ---
  const distinctStatusValues = useMemo(() => {
    if (!statusHeader) return [];
    const seen = new Set<string>();
    for (const row of session.rows) {
      const raw = row.raw[statusHeader];
      if (raw && raw.trim()) seen.add(raw.trim());
    }
    return [...seen];
  }, [statusHeader, session.rows]);

  const [statusMap, setStatusMap] = useState<Record<string, string>>({});
  const resolvedStatusMap = useMemo(() => {
    const synonyms = assetImportDescriptor.enumValueMaps.status?.synonyms ?? {};
    const out: Record<string, string> = {};
    for (const value of distinctStatusValues) {
      out[value] = statusMap[value] ?? synonyms[value.toLowerCase()] ?? "";
    }
    return out;
  }, [distinctStatusValues, statusMap]);

  // --- model brand/category constant fallbacks ("all models are brand X / category Y") ---
  // Only relevant once a model is in play (a column maps to it, or these constants pin it).
  const [manufacturerConst, setManufacturerConst] = useState("");
  const [categoryConst, setCategoryConst] = useState("");
  const modelManufacturerHeader = headers.find(
    (h) => choices[h]?.target === token("model", "manufacturer"),
  );
  const modelCategoryHeader = headers.find((h) => choices[h]?.target === token("model", "category"));

  // --- validation: a column must be mapped to `name` AND to `status` (ADR-0069 REDESIGN §6.2) ---
  const hasName = headers.some((h) => choices[h]?.target === token("asset", "name"));
  const hasStatus = Boolean(statusHeader);
  const missingRequired: string[] = [];
  if (!hasName) missingRequired.push(fieldLabel("import.asset.field.name"));
  if (!hasStatus) missingRequired.push(fieldLabel("import.asset.field.status"));

  // A custom column with no key yet is incomplete — block until the operator names it.
  const unnamedCustom = headers.some(
    (h) => choices[h]?.target === CUSTOM && !choices[h]?.customName.trim(),
  );

  const isBusy = setMapping.isPending || dryRun.isPending;
  const canContinue = missingRequired.length === 0 && !unnamedCustom && !isBusy;

  function buildMapping(): ImportMapping {
    const columns: ColumnFieldMapping[] = [];
    const references: FkFieldMapping[] = [];
    const custom: CustomFieldMapping[] = [];

    for (const h of headers) {
      const choice = choices[h];
      if (!choice || choice.target === IGNORE) continue;

      if (choice.target === CUSTOM) {
        const key = choice.customName.trim();
        if (key) custom.push({ column: h, key });
        continue;
      }

      const [entity, field] = choice.target.split(":");
      // Model brand/category are NOT CreateAsset keys — they drive `modelConfig`, handled below.
      if (entity === "model") continue;

      if (FK_FIELDS.has(field)) {
        references.push({ field, column: h, constant: null });
      } else {
        columns.push({ field, column: h, constant: null });
      }
    }

    const enums =
      distinctStatusValues.length > 0
        ? [
            {
              field: "status",
              values: distinctStatusValues
                .filter((from) => resolvedStatusMap[from])
                .map<EnumValueMapping>((from) => ({ from, to: resolvedStatusMap[from] })),
            },
          ]
        : [];

    // Model config: column wins, else the pinned constant (omit the whole blob if nothing is set).
    const mc: NonNullable<ModelConfig> = {};
    if (modelManufacturerHeader) mc.manufacturerColumn = modelManufacturerHeader;
    else if (manufacturerConst.trim()) mc.manufacturerConst = manufacturerConst.trim();
    if (modelCategoryHeader) mc.categoryColumn = modelCategoryHeader;
    else if (categoryConst.trim()) mc.categoryConst = categoryConst.trim();
    const modelConfig = Object.keys(mc).length > 0 ? mc : undefined;

    return { columns, references, enums, custom, modelConfig };
  }

  function handleSubmit() {
    if (!canContinue) return;
    const mapping = buildMapping();
    setMapping.mutate(
      { id: sessionId, mapping },
      {
        onSuccess: () => {
          dryRun.mutate(sessionId, {
            onSuccess: (report) => onMapped(report),
            onError: (error) => notify(error, "dryRun"),
          });
        },
        onError: (error) => notify(error, "mapping"),
      },
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("mapping.title")}</h2>
        <p className="max-w-prose text-sm text-muted-foreground">{t("mapping.description")}</p>
      </div>

      <p
        className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground"
        role="note"
      >
        {t("mapping.piiNote")}
      </p>

      {/* One card per column */}
      <ul className="space-y-2">
        {headers.map((header) => {
          const choice = choices[header] ?? { target: IGNORE, customName: "" };
          const samples = samplesByHeader[header] ?? [];
          const firstSample = samples[0];
          const isCustom = choice.target === CUSTOM;
          const isIgnored = choice.target === IGNORE;
          const isStatus = choice.target === token("asset", "status");
          const selectId = `map-${header}`;

          const badge = isIgnored
            ? { label: t("mapping.targetIgnore"), variant: "outline" as const }
            : isCustom
              ? {
                  label: choice.customName.trim()
                    ? t("mapping.targetCustomNamed", { name: choice.customName.trim() })
                    : t("mapping.targetCustom"),
                  variant: "secondary" as const,
                }
              : { label: targetLabel(choice.target), variant: "default" as const };

          return (
            <li key={header}>
              <details
                className="group overflow-hidden rounded-lg border bg-card transition-colors open:border-ring/50 open:bg-card data-[ignored=true]:bg-muted/30"
                data-ignored={isIgnored}
              >
                <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                  <svg
                    className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path
                      fillRule="evenodd"
                      d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] font-medium" title={header}>
                    {header}
                  </span>
                  <Badge variant={badge.variant} className="shrink-0 rounded-md">
                    {badge.label}
                  </Badge>
                  {firstSample !== undefined && (
                    <span
                      className="hidden max-w-[14rem] shrink truncate text-xs text-muted-foreground sm:inline"
                      title={firstSample}
                    >
                      {firstSample}
                    </span>
                  )}
                </summary>

                <div className="space-y-4 border-t bg-muted/20 px-3 pt-3 pb-4">
                  {/* Example values from the file */}
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">
                      {t("mapping.sampleValues")}
                    </p>
                    {samples.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {samples.map((value, i) => (
                          <code
                            key={`${value}-${i}`}
                            className="max-w-full truncate rounded-md border bg-card px-2 py-0.5 text-xs"
                            title={value}
                          >
                            {value}
                          </code>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">{t("mapping.noSamples")}</p>
                    )}
                  </div>

                  {/* Target picker */}
                  <div className="grid gap-1.5 sm:max-w-md">
                    <Label htmlFor={selectId}>{t("mapping.mapToLabel")}</Label>
                    <Select
                      value={choice.target}
                      onValueChange={(value) => setChoice(header, { target: value })}
                    >
                      <SelectTrigger id={selectId} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={IGNORE}>{t("mapping.targetIgnore")}</SelectItem>
                        <SelectSeparator />
                        <SelectGroup>
                          <SelectLabel>{t("mapping.group.asset")}</SelectLabel>
                          {IMPORT_UI_TARGETS.asset.map((f) => (
                            <SelectItem key={f.field} value={token("asset", f.field)}>
                              {fieldLabel(f.i18nKey)}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                        <SelectGroup>
                          <SelectLabel>{t("mapping.group.model")}</SelectLabel>
                          {IMPORT_UI_TARGETS.model.map((f) => (
                            <SelectItem key={f.field} value={token("model", f.field)}>
                              {fieldLabel(f.i18nKey)}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                        <SelectSeparator />
                        <SelectItem value={CUSTOM}>{t("mapping.targetCustom")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Custom field key */}
                  {isCustom && (
                    <div className="grid gap-1.5 sm:max-w-md">
                      <Label htmlFor={`${selectId}-key`}>{t("mapping.customNameLabel")}</Label>
                      <Input
                        id={`${selectId}-key`}
                        value={choice.customName}
                        placeholder={t("mapping.customNamePlaceholder")}
                        maxLength={100}
                        onChange={(e) => setChoice(header, { customName: e.target.value })}
                      />
                      <p className="text-xs text-muted-foreground">{t("mapping.customNote")}</p>
                    </div>
                  )}

                  {/* Status value → enum map (lives inside the status column's card) */}
                  {isStatus && (
                    <div className="space-y-2 rounded-lg border bg-card p-3">
                      <div className="space-y-0.5">
                        <p className="text-xs font-medium">{t("mapping.statusTitle")}</p>
                        <p className="text-xs text-muted-foreground">
                          {t("mapping.statusInColumnNote")}
                        </p>
                      </div>
                      {distinctStatusValues.length > 0 ? (
                        <div className="space-y-2">
                          {distinctStatusValues.map((value) => {
                            const id = `status-${header}-${value}`;
                            return (
                              <div
                                key={value}
                                className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]"
                              >
                                <Label htmlFor={id} className="truncate font-mono text-xs" title={value}>
                                  {value}
                                </Label>
                                <Select
                                  value={resolvedStatusMap[value] || IGNORE}
                                  onValueChange={(next) =>
                                    setStatusMap((prev) => ({
                                      ...prev,
                                      [value]: next === IGNORE ? "" : next,
                                    }))
                                  }
                                >
                                  <SelectTrigger id={id} className="w-full">
                                    <SelectValue placeholder={t("mapping.statusUnmapped")} />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value={IGNORE}>{t("mapping.statusUnmapped")}</SelectItem>
                                    {AssetStatusSchema.options.map((option) => (
                                      <SelectItem key={option} value={option}>
                                        {option}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">{t("mapping.statusNoValues")}</p>
                      )}
                    </div>
                  )}
                </div>
              </details>
            </li>
          );
        })}
      </ul>

      {/* Model brand + category — constant fallback when no column drives them */}
      <div className="space-y-3 rounded-lg border bg-card p-4">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium">{t("mapping.modelConfig.title")}</h3>
          <p className="text-xs text-muted-foreground">{t("mapping.modelConfig.description")}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="model-manufacturer-const">
              {t("mapping.modelConfig.manufacturerLabel")}
            </Label>
            <Input
              id="model-manufacturer-const"
              value={modelManufacturerHeader ? "" : manufacturerConst}
              placeholder={t("mapping.modelConfig.manufacturerPlaceholder")}
              disabled={Boolean(modelManufacturerHeader)}
              onChange={(e) => setManufacturerConst(e.target.value)}
            />
            {modelManufacturerHeader && (
              <p className="text-xs text-muted-foreground">
                {t("mapping.modelConfig.fromColumn", { column: modelManufacturerHeader })}
              </p>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="model-category-const">{t("mapping.modelConfig.categoryLabel")}</Label>
            <Input
              id="model-category-const"
              value={modelCategoryHeader ? "" : categoryConst}
              placeholder={t("mapping.modelConfig.categoryPlaceholder")}
              disabled={Boolean(modelCategoryHeader)}
              onChange={(e) => setCategoryConst(e.target.value)}
            />
            {modelCategoryHeader && (
              <p className="text-xs text-muted-foreground">
                {t("mapping.modelConfig.fromColumn", { column: modelCategoryHeader })}
              </p>
            )}
          </div>
        </div>
      </div>

      {missingRequired.length > 0 && (
        <p className="text-sm text-destructive" role="alert">
          {t("mapping.missingRequired", { fields: missingRequired.join(", ") })}
        </p>
      )}
      {missingRequired.length === 0 && unnamedCustom && (
        <p className="text-sm text-destructive" role="alert">
          {t("mapping.customNameMissing")}
        </p>
      )}

      <div className="flex justify-between">
        <Button type="button" variant="outline" onClick={onBack} disabled={isBusy}>
          {t("common.back")}
        </Button>
        <Button type="button" onClick={handleSubmit} disabled={!canContinue}>
          {isBusy && <ArrowPathIcon className="size-4 animate-spin" aria-hidden="true" />}
          {isBusy ? t("mapping.running") : t("mapping.submit")}
        </Button>
      </div>
    </div>
  );
}
