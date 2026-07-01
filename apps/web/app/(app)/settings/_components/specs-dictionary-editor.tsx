"use client";

import { PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import {
  type AssetSpecsDictionary,
  SPEC_FIELD_KEY_MAX,
  SPEC_FIELD_LABEL_MAX,
  SPEC_FIELD_TYPES,
  type SpecField,
  type SpecFieldType,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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

/**
 * Advisory per-category specs dictionary editor (ADR-0078, #851). Edits a `SpecField[]` as a list of
 * rows: key + label + type + required, plus a comma-separated enum-values input when the type is
 * `enum`. It NEVER blocks a save on its own — the parent form serializes {@link rowsToDictionary} and
 * runs the shared `AssetSpecsDictionarySchema` on submit, and the API hard-validates the shape too.
 *
 * The row keeps `enumValues` as raw comma-separated text (ponytail: a single Input is enough — no
 * chips widget) and only materializes the `string[]` at serialization for `enum` fields.
 */

export interface SpecsDictRow {
  id: string;
  key: string;
  label: string;
  type: SpecFieldType;
  required: boolean;
  /** Raw comma-separated text; only used (and split) when `type === "enum"`. */
  enumValues: string;
}

let dictRowSeq = 0;

export function makeSpecsDictRow(
  partial: Partial<Omit<SpecsDictRow, "id">> = {},
): SpecsDictRow {
  dictRowSeq += 1;
  return {
    id: `sd-${dictRowSeq}`,
    key: "",
    label: "",
    type: "string",
    required: false,
    enumValues: "",
    ...partial,
  };
}

/** Split a stored dictionary into editor rows (edit pre-fill). */
export function dictionaryToRows(
  dict: AssetSpecsDictionary | null | undefined,
): SpecsDictRow[] {
  return (dict ?? []).map((field) =>
    makeSpecsDictRow({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required ?? false,
      enumValues: (field.enumValues ?? []).join(", "),
    }),
  );
}

/**
 * Serialize editor rows into a `SpecField[]`. Fully-empty rows are dropped so a stray blank line never
 * blocks the save; the rest are validated by the caller with `AssetSpecsDictionarySchema`.
 */
export function rowsToDictionary(rows: SpecsDictRow[]): SpecField[] {
  const out: SpecField[] = [];
  for (const row of rows) {
    const key = row.key.trim();
    const label = row.label.trim();
    if (key === "" && label === "" && row.enumValues.trim() === "") continue;
    const field: SpecField = { key, label, type: row.type };
    if (row.required) field.required = true;
    if (row.type === "enum") {
      field.enumValues = row.enumValues
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value !== "");
    }
    out.push(field);
  }
  return out;
}

export function SpecsDictionaryEditor({
  rows,
  error,
  onChange,
}: {
  rows: SpecsDictRow[];
  error?: string;
  onChange: (rows: SpecsDictRow[]) => void;
}) {
  const t = useTranslations(
    "settings.taxonomies.categories.form.specsDictionary",
  );

  function updateRow(id: string, patch: Partial<SpecsDictRow>) {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }
  function removeRow(id: string) {
    onChange(rows.filter((row) => row.id !== id));
  }
  function addRow() {
    onChange([...rows, makeSpecsDictRow()]);
  }

  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel>{t("label")}</FieldLabel>
      <FieldDescription>{t("description")}</FieldDescription>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((row, index) => (
            <li key={row.id} className="space-y-2 rounded-md border p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  aria-label={t("fieldKeyLabel", { index: index + 1 })}
                  value={row.key}
                  onChange={(event) =>
                    updateRow(row.id, { key: event.target.value })
                  }
                  placeholder={t("keyPlaceholder")}
                  maxLength={SPEC_FIELD_KEY_MAX}
                />
                <Input
                  aria-label={t("fieldLabelLabel", { index: index + 1 })}
                  value={row.label}
                  onChange={(event) =>
                    updateRow(row.id, { label: event.target.value })
                  }
                  placeholder={t("labelPlaceholder")}
                  maxLength={SPEC_FIELD_LABEL_MAX}
                />
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Select
                  value={row.type}
                  onValueChange={(value) =>
                    updateRow(row.id, { type: value as SpecFieldType })
                  }
                >
                  <SelectTrigger className="w-44" aria-label={t("typeLabel")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SPEC_FIELD_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {t(`typeOptions.${type}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={row.required}
                    onCheckedChange={(checked) =>
                      updateRow(row.id, { required: checked === true })
                    }
                  />
                  {t("requiredLabel")}
                </label>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="ml-auto"
                  aria-label={t("removeFieldLabel", { index: index + 1 })}
                  title={t("removeFieldTitle")}
                  onClick={() => removeRow(row.id)}
                >
                  <TrashIcon />
                </Button>
              </div>

              {row.type === "enum" ? (
                <div>
                  <Input
                    aria-label={t("fieldEnumValuesLabel", { index: index + 1 })}
                    value={row.enumValues}
                    onChange={(event) =>
                      updateRow(row.id, { enumValues: event.target.value })
                    }
                    placeholder={t("enumValuesPlaceholder")}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("enumValuesHint")}
                  </p>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div>
        <Button type="button" variant="outline" size="sm" onClick={addRow}>
          <PlusIcon />
          {t("addField")}
        </Button>
      </div>

      {error ? <FieldError errors={[{ message: error }]} /> : null}
    </Field>
  );
}
