"use client";

import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Combobox } from "@/components/combobox";
import { useConsumable, useConsumables } from "@/lib/api/hooks/use-consumables";

/**
 * A server-search consumable picker (ADR-0098 delivery dialog): the {@link Combobox} wired to the
 * `q`-driven paged `useConsumables` list (active consumables only — the list excludes soft-deleted rows
 * by default). Each option shows the on-hand count, and an out-of-stock item is offered but disabled —
 * there is nothing to deliver. The selected consumable's name is resolved via `useConsumable` so the
 * trigger keeps showing it after the search pages away.
 *
 * Controlled by `value`/`onValueChange` (the consumable id); forwards `id` + `ariaInvalid` for the
 * `Field`/`FieldError` + `Controller` contract, like the user/asset/location pickers.
 */
export function ConsumableCombobox({
  id,
  value,
  onValueChange,
  ariaInvalid,
  disabled,
  placeholder,
  searchPlaceholder,
  emptyText,
}: {
  id?: string;
  value?: string;
  onValueChange: (value: string) => void;
  ariaInvalid?: boolean;
  disabled?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
}) {
  const tc = useTranslations("common");
  const t = useTranslations("consumables.deliveries.picker");
  const [query, setQuery] = useState("");
  const { data, isFetching } = useConsumables({
    q: query || undefined,
    limit: 50,
  });
  const { data: selected } = useConsumable(value || undefined);

  const items = useMemo(
    () =>
      (data?.items ?? []).map((consumable) => ({
        value: consumable.id,
        label: t("option", {
          name: consumable.name,
          count: consumable.currentStock,
          unit: consumable.unit,
        }),
        keywords: consumable.sku ? [consumable.sku] : undefined,
        disabled: consumable.currentStock <= 0,
      })),
    [data, t],
  );

  return (
    <Combobox
      id={id}
      value={value}
      onValueChange={onValueChange}
      items={items}
      onSearchChange={setQuery}
      loading={isFetching}
      selectedLabel={selected?.name}
      aria-invalid={ariaInvalid}
      disabled={disabled}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      emptyText={emptyText}
      loadingText={tc("searching")}
      typeToSearchText={tc("typeToSearch")}
    />
  );
}
