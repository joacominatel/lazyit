"use client";

import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Combobox } from "@/components/combobox";
import {
  useApplication,
  useApplicationList,
} from "@/lib/api/hooks/use-applications";

/**
 * A server-search application picker — the {@link Combobox} wired to the `q`-driven paged
 * `useApplicationList` hook (applications support server-side `q`). Mirrors {@link AssetCombobox}
 * and {@link UserCombobox}: any application is reachable by search, never capped to a first page.
 * The selected application's name is resolved via `useApplication` so the trigger keeps showing it
 * even when that row has paged out of the current query.
 *
 * Controlled by `value`/`onValueChange` (the application id; an empty string clears it). Forwards
 * `id` + `ariaInvalid` for the `Field`/`FieldError` + `Controller` contract.
 */
export function ApplicationCombobox({
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
  const { data, isFetching } = useApplicationList({
    q: query || undefined,
    limit: 50,
  });
  const { data: selected } = useApplication(value || undefined);

  const items = useMemo(
    () =>
      (data?.items ?? []).map((application) => ({
        value: application.id,
        label: application.name,
        keywords: application.vendor ? [application.vendor] : undefined,
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
      loadingText={tc("searching")}
      typeToSearchText={tc("typeToSearch")}
    />
  );
}
