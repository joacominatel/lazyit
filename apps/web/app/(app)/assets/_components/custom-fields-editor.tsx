"use client";

import { PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/**
 * One editable custom field — a `{ key, value }` pair the user adds to an asset's
 * free-form `specs` jsonb. `id` is a stable client-only key for React list identity
 * (specs keys can change/collide while editing, so they can't be the React key).
 * Values are plain strings to start ("se envie en json y listo" — ADR-0007); the
 * editor never produces nested objects/arrays.
 */
export interface CustomFieldRow {
  id: string;
  key: string;
  value: string;
}

let rowSeq = 0;
/** A fresh empty row with a unique client id. */
export function makeCustomFieldRow(
  partial: Partial<Omit<CustomFieldRow, "id">> = {},
): CustomFieldRow {
  rowSeq += 1;
  return { id: `cf-${rowSeq}`, key: "", value: "", ...partial };
}

/**
 * Split an asset's `specs` object into (1) editable scalar rows and (2) the
 * **preserved** non-scalar entries (arrays/objects) the editor can't represent.
 * Preserving the latter honours "do not drop unknown keys": they round-trip
 * untouched via {@link rowsToSpecs}. Scalars become string-valued rows (booleans/
 * numbers stringify; the editor's value type is string).
 */
export function specsToRows(specs: Record<string, unknown> | null | undefined): {
  rows: CustomFieldRow[];
  preserved: Record<string, unknown>;
} {
  const rows: CustomFieldRow[] = [];
  const preserved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(specs ?? {})) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      rows.push(makeCustomFieldRow({ key, value: String(value) }));
    } else {
      // Arrays, nested objects, null — keep verbatim, out of the editor's reach.
      preserved[key] = value;
    }
  }
  return { rows, preserved };
}

/**
 * A stable error code for a custom-field row, translated at the render site (the codes
 * map to keys under `assets.form.customFields`). `validateRows` is a pure helper called
 * outside React render, so it can't translate — it returns codes instead of copy.
 */
export type CustomFieldError = "nameRequired" | "duplicateName";

/**
 * Per-row validation problems for the custom-fields editor, keyed by row `id`:
 * a missing key on a row that has a value, or a key that duplicates an earlier row.
 * A row that is entirely empty (no key, no value) is ignored — it's just a blank
 * slot the user hasn't filled in. Values are stable error codes (see {@link CustomFieldError}).
 */
export function validateRows(rows: CustomFieldRow[]): {
  errors: Record<string, CustomFieldError>;
  ok: boolean;
} {
  const errors: Record<string, CustomFieldError> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    const hasValue = row.value.trim() !== "";
    if (key === "") {
      if (hasValue) errors[row.id] = "nameRequired";
      continue;
    }
    if (seen.has(key)) {
      errors[row.id] = "duplicateName";
      continue;
    }
    seen.add(key);
  }
  return { errors, ok: Object.keys(errors).length === 0 };
}

/**
 * Serialize editable rows back into a `specs` object, merging the preserved
 * non-scalar entries on top of nothing (preserved wins only for keys the editor
 * doesn't own). Empty rows (no trimmed key) are dropped; remaining values are kept
 * as trimmed strings. Returns `undefined` when the result is empty so the form omits
 * `specs` entirely rather than sending `{}`.
 */
export function rowsToSpecs(
  rows: CustomFieldRow[],
  preserved: Record<string, unknown> = {},
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key === "") continue;
    out[key] = row.value.trim();
  }
  // Preserved (non-scalar) keys round-trip untouched; scalar rows take precedence
  // if a user re-created a key that also existed as a preserved entry.
  for (const [key, value] of Object.entries(preserved)) {
    if (!(key in out)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A dynamic list of `{ name, value }` rows that serialize into an asset's `specs`
 * jsonb (ADR-0007). Fully controlled: the parent owns `rows` + `errors` (compute via
 * {@link validateRows}) and serializes via {@link rowsToSpecs}. Add appends a blank
 * row; the trash button removes one. Per-row key errors (empty/duplicate) render
 * inline. Non-scalar legacy entries are preserved by the parent, not shown here.
 */
export function CustomFieldsEditor({
  rows,
  errors,
  onChange,
}: {
  rows: CustomFieldRow[];
  errors: Record<string, CustomFieldError>;
  onChange: (rows: CustomFieldRow[]) => void;
}) {
  const t = useTranslations("assets.form.customFields");

  function updateRow(id: string, patch: Partial<CustomFieldRow>) {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }
  function removeRow(id: string) {
    onChange(rows.filter((row) => row.id !== id));
  }
  function addRow() {
    onChange([...rows, makeCustomFieldRow()]);
  }

  return (
    <Field>
      <FieldLabel>{t("label")}</FieldLabel>
      <FieldDescription>{t("description")}</FieldDescription>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row, index) => {
            const error = errors[row.id];
            return (
              <li key={row.id} className="space-y-1">
                <div className="flex items-start gap-2">
                  <Input
                    aria-label={t("fieldNameLabel", { index: index + 1 })}
                    aria-invalid={error ? true : undefined}
                    value={row.key}
                    onChange={(event) =>
                      updateRow(row.id, { key: event.target.value })
                    }
                    placeholder={t("namePlaceholder")}
                    className="flex-1"
                  />
                  <Input
                    aria-label={t("fieldValueLabel", { index: index + 1 })}
                    value={row.value}
                    onChange={(event) =>
                      updateRow(row.id, { value: event.target.value })
                    }
                    placeholder={t("valuePlaceholder")}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("removeFieldLabel", { index: index + 1 })}
                    title={t("removeFieldTitle")}
                    onClick={() => removeRow(row.id)}
                  >
                    <TrashIcon />
                  </Button>
                </div>
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {t(error)}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addRow}
        >
          <PlusIcon />
          {t("addField")}
        </Button>
      </div>
    </Field>
  );
}
