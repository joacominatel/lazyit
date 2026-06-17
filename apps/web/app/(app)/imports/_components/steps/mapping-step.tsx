"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import {
  assetImportDescriptor,
  AssetStatusSchema,
  type ColumnFieldMapping,
  type EnumValueMapping,
  type FkFieldMapping,
  type ImportMapping,
  type ImportSessionView,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useRunImportDryRun,
  useSetImportMapping,
} from "@/lib/api/hooks/use-imports";
import type { ImportDryRunReport } from "@lazyit/shared";
import { useImportError } from "../use-import-error";

/** Sentinel for "not mapped to any column" in a Select (Radix Select can't hold an empty value). */
const NO_COLUMN = "__none__";

/** Normalize a header / field for fuzzy auto-suggest (case-fold, strip non-alphanumerics). */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The FK fields per the descriptor (modelId, locationId) — they go in `references`, not `columns`. */
const FK_FIELDS = new Set(Object.keys(assetImportDescriptor.references));

/**
 * Step 3 — Mapping (ADR-0069 §4). Three layers, all operator-confirmed (auto-suggest is a suggestion,
 * never auto-applied):
 *  - column → field: each mappable field (from `assetImportDescriptor.mappableFields`) binds to a
 *    source column OR a pinned constant. FK fields (model/location) carry a hint that they resolve by
 *    name. Required-no-default fields (name, status) must be mapped or pinned before continuing.
 *  - value → enum: the `status` field gets a value-map row per distinct source value → an AssetStatus.
 *  - field → FK: model/location are declared references (resolved by the dry-run engine).
 *
 * On submit: `POST mapping` (→ MAPPED) then `POST dry-run` (→ the report), handed up to the preview
 * step. Each labelled control wires `htmlFor`/`id` for keyboard + screen-reader access.
 */
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
  const fields = assetImportDescriptor.mappableFields;

  // i18n label per mappable field (the descriptor carries a shared i18n KEY like
  // "import.asset.field.name"; we render the last segment under our own namespace).
  const fieldLabel = (i18nKey: string): string => {
    const leaf = i18nKey.split(".").pop() ?? i18nKey;
    return t(`mapping.field.${leaf}` as Parameters<typeof t>[0]);
  };

  // --- column/constant bindings, seeded from a normalized auto-suggest (suggestion only) ---
  const initialColumns = useMemo<Record<string, { column: string | null; constant: string }>>(() => {
    const out: Record<string, { column: string | null; constant: string }> = {};
    for (const f of fields) {
      const guess = headers.find((h) => normalize(h) === normalize(f.field));
      out[f.field] = { column: guess ?? null, constant: "" };
    }
    return out;
  }, [fields, headers]);

  const [bindings, setBindings] = useState(initialColumns);

  // --- status value-map: one row per distinct raw value found across the sampled rows ---
  const statusColumn = bindings.status?.column;
  const distinctStatusValues = useMemo(() => {
    if (!statusColumn) return [];
    const seen = new Set<string>();
    for (const row of session.rows) {
      const raw = row.raw[statusColumn];
      if (raw && raw.trim()) seen.add(raw.trim());
    }
    return [...seen];
  }, [statusColumn, session.rows]);

  const [statusMap, setStatusMap] = useState<Record<string, string>>({});
  // Auto-suggest each distinct value via the descriptor synonym table (operator can override).
  const resolvedStatusMap = useMemo(() => {
    const synonyms = assetImportDescriptor.enumValueMaps.status?.synonyms ?? {};
    const out: Record<string, string> = {};
    for (const value of distinctStatusValues) {
      out[value] = statusMap[value] ?? synonyms[value.toLowerCase()] ?? "";
    }
    return out;
  }, [distinctStatusValues, statusMap]);

  function setBinding(field: string, patch: Partial<{ column: string | null; constant: string }>) {
    setBindings((prev) => ({ ...prev, [field]: { ...prev[field], ...patch } }));
  }

  // Required-no-default fields must be mapped or pinned before we can continue (ADR-0069 §4).
  const missingRequired = fields
    .filter((f) => f.required)
    .filter((f) => {
      const b = bindings[f.field];
      return !b?.column && !b?.constant.trim();
    })
    .map((f) => fieldLabel(f.i18nKey));

  const isBusy = setMapping.isPending || dryRun.isPending;

  function buildMapping(): ImportMapping {
    const columns: ColumnFieldMapping[] = [];
    const references: FkFieldMapping[] = [];
    for (const f of fields) {
      const b = bindings[f.field];
      if (!b) continue;
      const column = b.column ?? null;
      const constant = b.constant.trim() ? b.constant.trim() : null;
      if (!column && !constant) continue; // unmapped → dropped before validation
      if (FK_FIELDS.has(f.field)) {
        references.push({ field: f.field, column, constant });
      } else {
        columns.push({ field: f.field, column, constant });
      }
    }
    const enums =
      distinctStatusValues.length > 0
        ? [
            {
              field: "status",
              values: distinctStatusValues
                .filter((from) => resolvedStatusMap[from])
                .map<EnumValueMapping>((from) => ({
                  from,
                  to: resolvedStatusMap[from],
                })),
            },
          ]
        : [];
    return { columns, references, enums };
  }

  function handleSubmit() {
    if (missingRequired.length > 0) return;
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
        <p className="text-sm text-muted-foreground">{t("mapping.description")}</p>
      </div>

      {/* Column → field bindings */}
      <div className="space-y-4">
        {fields.map((f) => {
          const id = `map-${f.field}`;
          const b = bindings[f.field];
          const isFk = FK_FIELDS.has(f.field);
          return (
            <div key={f.field} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-start">
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor={id} className="flex items-center gap-1.5">
                    {fieldLabel(f.i18nKey)}
                    {f.required && (
                      <span className="text-xs font-normal text-destructive">
                        {t("mapping.required")}
                      </span>
                    )}
                  </Label>
                  <Select
                    value={b?.column ?? NO_COLUMN}
                    onValueChange={(value) =>
                      setBinding(f.field, {
                        column: value === NO_COLUMN ? null : value,
                      })
                    }
                  >
                    <SelectTrigger id={id} className="w-full">
                      <SelectValue placeholder={t("mapping.selectColumn")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_COLUMN}>{t("mapping.noColumn")}</SelectItem>
                      {headers.map((header) => (
                        <SelectItem key={header} value={header}>
                          {header}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${id}-const`} className="text-muted-foreground">
                    {t("mapping.constantColumn")}
                  </Label>
                  <Input
                    id={`${id}-const`}
                    value={b?.constant ?? ""}
                    placeholder={t("mapping.constantPlaceholder")}
                    disabled={Boolean(b?.column)}
                    onChange={(e) => setBinding(f.field, { constant: e.target.value })}
                  />
                </div>
              </div>
              {isFk && (
                <p className="text-xs text-muted-foreground sm:max-w-[12rem] sm:pt-7">
                  {t("mapping.fkNote")}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* Status value → enum map */}
      {distinctStatusValues.length > 0 && (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="space-y-1">
            <h3 className="text-sm font-medium">{t("mapping.statusTitle")}</h3>
            <p className="text-xs text-muted-foreground">{t("mapping.statusDescription")}</p>
          </div>
          <div className="space-y-2">
            {distinctStatusValues.map((value) => {
              const id = `status-${value}`;
              return (
                <div key={value} className="grid items-center gap-2 sm:grid-cols-2">
                  <Label htmlFor={id} className="font-mono text-xs">
                    {value}
                  </Label>
                  <Select
                    value={resolvedStatusMap[value] || NO_COLUMN}
                    onValueChange={(next) =>
                      setStatusMap((prev) => ({
                        ...prev,
                        [value]: next === NO_COLUMN ? "" : next,
                      }))
                    }
                  >
                    <SelectTrigger id={id} className="w-full">
                      <SelectValue placeholder={t("mapping.statusUnmapped")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_COLUMN}>{t("mapping.statusUnmapped")}</SelectItem>
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
        </div>
      )}

      {missingRequired.length > 0 && (
        <p className="text-sm text-destructive" role="alert">
          {t("mapping.missingRequired", { fields: missingRequired.join(", ") })}
        </p>
      )}

      <div className="flex justify-between">
        <Button type="button" variant="outline" onClick={onBack} disabled={isBusy}>
          {t("common.back")}
        </Button>
        <Button
          type="button"
          onClick={handleSubmit}
          disabled={isBusy || missingRequired.length > 0}
        >
          {isBusy && <ArrowPathIcon className="size-4 animate-spin" aria-hidden="true" />}
          {isBusy ? t("mapping.running") : t("mapping.submit")}
        </Button>
      </div>
    </div>
  );
}
