"use client";

import { useMemo, useState } from "react";
import { Combobox } from "@/components/combobox";
import { useLocation, useLocationList } from "@/lib/api/hooks/use-locations";

/**
 * A server-search location picker (issue #199): the {@link Combobox} wired to the `q`-driven paged
 * `useLocationList` hook (locations already support server-side `q` — ADR-0030/0035). Replaces the
 * plain `Select` on the asset form. The selected location name is resolved via `useLocation` so the
 * trigger shows it on edit even before the user searches.
 *
 * Controlled by `value`/`onValueChange` (the location id; an empty string clears it). Forwards `id` +
 * `ariaInvalid` for the `Field`/`FieldError` + `Controller` contract.
 */
export function LocationCombobox({
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
  const [query, setQuery] = useState("");
  const { data, isFetching } = useLocationList({
    q: query || undefined,
    limit: 50,
  });
  const { data: selected } = useLocation(value || undefined);

  const items = useMemo(
    () =>
      (data?.items ?? []).map((location) => ({
        value: location.id,
        label: location.name,
      })),
    [data],
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
    />
  );
}
