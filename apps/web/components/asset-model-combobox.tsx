"use client";

import type { AssetModel } from "@lazyit/shared";
import { useMemo, useState } from "react";
import { Combobox } from "@/components/combobox";
import {
  useAssetModel,
  useAssetModelList,
} from "@/lib/api/hooks/use-asset-models";

/**
 * A server-search asset-model picker (issue #199): the {@link Combobox} wired to the `q`-driven paged
 * `useAssetModelList` hook (backed by the new `GET /asset-models?q=` — see asset-models.controller).
 * Replaces the plain `Select` that materialized every model just to populate the asset form. The
 * selected model's "Manufacturer Name" label is resolved via `useAssetModel`, so the trigger keeps
 * showing it on edit even before/after the user searches.
 *
 * Controlled by `value`/`onValueChange` (the model id; an empty string clears it). Forwards `id` +
 * `ariaInvalid` for the `Field`/`FieldError` + `Controller` contract.
 */
export function AssetModelCombobox({
  id,
  value,
  onValueChange,
  onModelSelect,
  ariaInvalid,
  disabled,
  placeholder,
  searchPlaceholder,
  emptyText,
}: {
  id?: string;
  value?: string;
  onValueChange: (value: string) => void;
  onModelSelect?: (model: AssetModel) => void;
  ariaInvalid?: boolean;
  disabled?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
}) {
  const [query, setQuery] = useState("");
  const { data, isFetching } = useAssetModelList({
    q: query || undefined,
    limit: 50,
  });
  const { data: selected } = useAssetModel(value || undefined);

  const items = useMemo(
    () =>
      (data?.items ?? []).map((model) => ({
        value: model.id,
        label: `${model.manufacturer} ${model.name}`,
        keywords: model.sku ? [model.sku] : undefined,
      })),
    [data],
  );

  return (
    <Combobox
      id={id}
      value={value}
      onValueChange={(next) => {
        onValueChange(next);
        const model = data?.items.find((item) => item.id === next);
        if (model) onModelSelect?.(model);
      }}
      items={items}
      onSearchChange={setQuery}
      loading={isFetching}
      selectedLabel={
        selected ? `${selected.manufacturer} ${selected.name}` : undefined
      }
      aria-invalid={ariaInvalid}
      disabled={disabled}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      emptyText={emptyText}
    />
  );
}
