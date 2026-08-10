"use client";

import type { AssetModel } from "@lazyit/shared";
import { useTranslations } from "next-intl";
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
  onSearchChange,
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
  /**
   * Optional mirror of the debounced search term (issue #1229): the picker owns its own query — this
   * only lets a caller *observe* it, e.g. to seed an inline "create model" dialog with what the
   * operator was searching for when they found nothing. Note the picker resets its query to `""`
   * when the popover closes, so a caller that wants the term afterwards must keep the last
   * non-empty one.
   */
  onSearchChange?: (query: string) => void;
  ariaInvalid?: boolean;
  disabled?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
}) {
  const tc = useTranslations("common");
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

  // Quick View (ADR-0072): the eye reads the ALREADY-LOADED list row — zero extra fetch. The model
  // row is the full AssetModel (manufacturer/name/sku/description). No detail route → no footer link.
  const byId = useMemo(
    () => new Map((data?.items ?? []).map((model) => [model.id, model])),
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
      onSearchChange={(next) => {
        setQuery(next);
        onSearchChange?.(next);
      }}
      loading={isFetching}
      selectedLabel={
        selected ? `${selected.manufacturer} ${selected.name}` : undefined
      }
      aria-invalid={ariaInvalid}
      disabled={disabled}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      emptyText={emptyText}
      loadingText={tc("searching")}
      typeToSearchText={tc("typeToSearch")}
      quickView={(rowId) => {
        const model = byId.get(rowId);
        return model ? { entity: "assetModel", data: model } : null;
      }}
    />
  );
}
