"use client";

import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Combobox } from "@/components/combobox";
import { useSupplier, useSuppliers } from "@/lib/api/hooks/use-suppliers";

/** A server-search supplier picker — the supplier filter of the purchases list. */
export function SupplierCombobox({
  id,
  value,
  onValueChange,
  placeholder,
  className,
}: {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const tc = useTranslations("common");
  const [query, setQuery] = useState("");
  const { data, isFetching } = useSuppliers({ q: query || undefined, limit: 50 });
  const { data: selected } = useSupplier(value || undefined);
  const items = useMemo(
    () =>
      (data?.items ?? []).map((supplier) => ({
        value: supplier.id,
        label: supplier.name,
        keywords: supplier.taxId ? [supplier.taxId] : undefined,
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
      placeholder={placeholder}
      loadingText={tc("searching")}
      typeToSearchText={tc("typeToSearch")}
      className={className}
    />
  );
}
