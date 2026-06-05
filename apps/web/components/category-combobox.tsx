"use client";

import { useMemo } from "react";
import { Combobox } from "@/components/combobox";

/**
 * A client-filter category picker (issue #199): the {@link Combobox} in client-filter mode over a
 * small, curated category list passed in by the caller (asset categories or consumable categories —
 * those stay client-filter-only by decision; the override does NOT add server search there). Used by
 * the asset-model and consumable forms.
 *
 * Category is optional, so an empty `value` means "no category" — selecting the current value again
 * clears it (the Combobox's toggle), which is the inline equivalent of the old "— None —" item.
 * Controlled by `value`/`onValueChange` (the category id; `""` clears it); forwards `id` for the
 * `Field`/`FieldError` + `Controller` label association.
 */
export function CategoryCombobox({
  id,
  value,
  onValueChange,
  categories,
  disabled,
  placeholder,
  searchPlaceholder,
  emptyText,
}: {
  id?: string;
  value?: string;
  onValueChange: (value: string) => void;
  categories: { id: string; name: string }[];
  disabled?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
}) {
  const items = useMemo(
    () => categories.map((category) => ({ value: category.id, label: category.name })),
    [categories],
  );

  return (
    <Combobox
      id={id}
      value={value}
      onValueChange={onValueChange}
      items={items}
      disabled={disabled}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      emptyText={emptyText}
    />
  );
}
