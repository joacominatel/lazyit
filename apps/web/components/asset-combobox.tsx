"use client";

import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Combobox } from "@/components/combobox";
import { useAsset, useAssets } from "@/lib/api/hooks/use-assets";

/**
 * A server-search asset picker (issue #199): the {@link Combobox} wired to the `q`-driven paged
 * `useAssets` hook (assets already support server-side `q` — ADR-0030/0035). Replaces the plain
 * `Select` on the KB link flow, which previously loaded only the first 200 assets — so anything past
 * the 200th asset was simply unpickable once the fleet grew. Now any asset is reachable by search.
 * The selected asset's name is resolved via `useAsset` so the trigger keeps showing it.
 *
 * Controlled by `value`/`onValueChange` (the asset id; an empty string clears it). Forwards `id` +
 * `ariaInvalid` for the `Field`/`FieldError` + `Controller` contract.
 */
export function AssetCombobox({
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
  const [query, setQuery] = useState("");
  const { data, isFetching } = useAssets({ q: query || undefined, limit: 50 });
  const { data: selected } = useAsset(value || undefined);

  const items = useMemo(
    () =>
      (data?.items ?? []).map((asset) => ({
        value: asset.id,
        label: asset.name,
        keywords: [asset.assetTag, asset.serial].filter(
          (term): term is string => Boolean(term),
        ),
      })),
    [data],
  );

  // Quick View (ADR-0072): the eye reads the ALREADY-LOADED list row — zero extra fetch. The row
  // carries the full graph the preview needs (serial/assetTag/status + trimmed model/category/location).
  const byId = useMemo(
    () => new Map((data?.items ?? []).map((asset) => [asset.id, asset])),
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
      loadingText={tc("searching")}
      typeToSearchText={tc("typeToSearch")}
      quickView={(rowId) => {
        const asset = byId.get(rowId);
        return asset ? { entity: "asset", data: asset } : null;
      }}
    />
  );
}
