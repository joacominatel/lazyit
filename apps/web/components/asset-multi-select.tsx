"use client";

import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import {
  EntityMultiSelect,
  type EntityMultiSelectItem,
} from "@/components/entity-multi-select";
import { useAssets } from "@/lib/api/hooks/use-assets";

/**
 * A **server-search** asset multi-select (issue #213): {@link EntityMultiSelect} wired to the
 * `q`-driven paged `useAssets` hook (assets already support server-side `q` — ADR-0030/0035). The
 * KB-list counterpart of the single-select {@link AssetCombobox} (#199) — same server-search infra,
 * but for picking SEVERAL specific assets to filter the article list by. No 200-asset ceiling: any
 * asset is reachable by search, regardless of fleet size.
 *
 * Fully controlled by `selected` (the chosen asset ids) + `onChange`. The selected assets' names are
 * resolved by-id elsewhere (the active-filter chips on the page, via `useAsset`), so an id off the
 * current search page still renders its label.
 */
export function AssetMultiSelect({
  selected,
  onChange,
  className,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  className?: string;
}) {
  const t = useTranslations("kb");
  const [query, setQuery] = useState("");
  const { data, isFetching } = useAssets({ q: query || undefined, limit: 50 });

  const items = useMemo<EntityMultiSelectItem[]>(
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

  return (
    <EntityMultiSelect
      label={t("filters.assetLabelName")}
      items={items}
      selected={selected}
      onChange={onChange}
      onSearchChange={setQuery}
      loading={isFetching}
      searchPlaceholder={t("filters.searchAsset")}
      emptyText={t("filters.noAssets")}
      className={className}
    />
  );
}
