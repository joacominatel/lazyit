"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/**
 * "Fixed value: existing | constant" control for the migrator mapping step (#640). A field that no CSV
 * column drives can be pinned for every imported row. Two modes, toggled by a Switch (default = existing):
 *
 *  - **existing** (default): a {@link picker} slot — a design-system Combobox over the live entities. The
 *    parent wires the picker so that selecting an entity writes that entity's NATURAL KEY (name/sku) into
 *    `value` (NOT the id), so the dry-run resolver matches it instead of silently creating a new one.
 *  - **constant**: today's free-text {@link Input} — an arbitrary value applied to every row.
 *
 * Either way the OUTPUT is the same `value` string the parent persists as the `*Const` in `modelConfig`;
 * only how it's chosen differs. When a column already drives the field the whole control is `disabled`
 * (the column wins) and `fromColumn` is shown by the parent.
 *
 * Callers without an entity to pick (e.g. Manufacturer has no entity — it's a plain string on AssetModel)
 * omit {@link picker}; the control then degrades to the plain constant input with no toggle.
 */
export function FixedValueField({
  id,
  label,
  value,
  onConstantChange,
  constantPlaceholder,
  picker,
  mode,
  onModeChange,
  disabled,
  fromColumn,
}: {
  id: string;
  label: string;
  /** The current constant string (only meaningful in `constant` mode). */
  value: string;
  /** Called as the operator types a free constant. */
  onConstantChange: (value: string) => void;
  constantPlaceholder?: string;
  /** The "existing" picker slot. Omit to render constant-only (no toggle). */
  picker?: ReactNode;
  /** Current mode — `true` = pick an existing value, `false` = free constant. */
  mode: boolean;
  /** Toggle the mode. Only used when a `picker` is supplied. */
  onModeChange: (existing: boolean) => void;
  disabled?: boolean;
  /** When a column drives this field, the localized "Taken from the column …" note. */
  fromColumn?: ReactNode;
}) {
  const t = useTranslations("imports.mapping.fixedValue");

  return (
    <div className="grid gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {picker && (
          <div className="flex items-center gap-1.5">
            <Switch
              id={`${id}-mode`}
              size="sm"
              checked={mode}
              disabled={disabled}
              onCheckedChange={onModeChange}
              aria-label={t("toggleAria")}
            />
            <span className="text-xs text-muted-foreground">
              {mode ? t("modeExisting") : t("modeConstant")}
            </span>
          </div>
        )}
      </div>

      {picker && mode ? (
        picker
      ) : (
        <Input
          id={id}
          value={value}
          placeholder={constantPlaceholder}
          disabled={disabled}
          onChange={(e) => onConstantChange(e.target.value)}
        />
      )}

      {!disabled && picker && (
        <p className="text-xs text-muted-foreground">{t("helper")}</p>
      )}
      {fromColumn}
    </div>
  );
}
