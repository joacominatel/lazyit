"use client";

import { PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export interface SpecsFieldRow {
  id: string;
  key: string;
  value: string;
}

let rowSeq = 0;

export function makeSpecsFieldRow(
  partial: Partial<Omit<SpecsFieldRow, "id">> = {},
): SpecsFieldRow {
  rowSeq += 1;
  return { id: `sf-${rowSeq}`, key: "", value: "", ...partial };
}

export function specsToRows(specs: Record<string, unknown> | null | undefined): {
  rows: SpecsFieldRow[];
  preserved: Record<string, unknown>;
} {
  const rows: SpecsFieldRow[] = [];
  const preserved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(specs ?? {})) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      rows.push(makeSpecsFieldRow({ key, value: String(value) }));
    } else {
      preserved[key] = value;
    }
  }
  return { rows, preserved };
}

export type SpecsFieldError = "nameRequired" | "duplicateName";

export function validateRows(rows: SpecsFieldRow[]): {
  errors: Record<string, SpecsFieldError>;
  ok: boolean;
} {
  const errors: Record<string, SpecsFieldError> = {};
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

export function rowsToSpecs(
  rows: SpecsFieldRow[],
  preserved: Record<string, unknown> = {},
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key === "") continue;
    out[key] = row.value.trim();
  }
  for (const [key, value] of Object.entries(preserved)) {
    if (!(key in out)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface SpecsFieldsEditorLabels {
  label: string;
  description: string;
  empty: string;
  namePlaceholder: string;
  valuePlaceholder: string;
  removeFieldTitle: string;
  addField: string;
  nameRequired: string;
  duplicateName: string;
  fieldNameLabel: (index: number) => string;
  fieldValueLabel: (index: number) => string;
  removeFieldLabel: (index: number) => string;
}

export function SpecsFieldsEditor({
  rows,
  errors,
  labels,
  note,
  onChange,
}: {
  rows: SpecsFieldRow[];
  errors: Record<string, SpecsFieldError>;
  labels: SpecsFieldsEditorLabels;
  note?: string;
  onChange: (rows: SpecsFieldRow[]) => void;
}) {
  function updateRow(id: string, patch: Partial<SpecsFieldRow>) {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }
  function removeRow(id: string) {
    onChange(rows.filter((row) => row.id !== id));
  }
  function addRow() {
    onChange([...rows, makeSpecsFieldRow()]);
  }

  return (
    <Field>
      <FieldLabel>{labels.label}</FieldLabel>
      <FieldDescription>{labels.description}</FieldDescription>
      {note ? (
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          {note}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{labels.empty}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row, index) => {
            const error = errors[row.id];
            return (
              <li key={row.id} className="space-y-1">
                <div className="flex items-start gap-2">
                  <Input
                    aria-label={labels.fieldNameLabel(index + 1)}
                    aria-invalid={error ? true : undefined}
                    value={row.key}
                    onChange={(event) =>
                      updateRow(row.id, { key: event.target.value })
                    }
                    placeholder={labels.namePlaceholder}
                    className="flex-1"
                  />
                  <Input
                    aria-label={labels.fieldValueLabel(index + 1)}
                    value={row.value}
                    onChange={(event) =>
                      updateRow(row.id, { value: event.target.value })
                    }
                    placeholder={labels.valuePlaceholder}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={labels.removeFieldLabel(index + 1)}
                    title={labels.removeFieldTitle}
                    onClick={() => removeRow(row.id)}
                  >
                    <TrashIcon />
                  </Button>
                </div>
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {labels[error]}
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
          {labels.addField}
        </Button>
      </div>
    </Field>
  );
}
