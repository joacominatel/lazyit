"use client";

import { MAX_PAGE_LIMIT, type Supplier } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { SuggestInput } from "@/components/suggest-input";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getSuppliers } from "@/lib/api/endpoints/suppliers";
import { useSuggestions } from "@/lib/api/hooks/use-suggestions";
import { useSuppliers } from "@/lib/api/hooks/use-suppliers";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { resolveSupplier, type SupplierResolution } from "@/lib/purchases/supplier";

/** The suppliers whose name contains `name`, for resolving it on save (the exact match is picked there). */
export async function findSuppliersNamed(name: string): Promise<Supplier[]> {
  const page = await getSuppliers({ q: name.trim(), limit: MAX_PAGE_LIMIT, sort: "name", dir: "asc" });
  return page.items;
}

/** One line to tell same-named suppliers apart. */
function supplierChoiceLabel(supplier: Supplier): string {
  return [supplier.name, supplier.taxId, supplier.website, supplier.salesContactEmail]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The supplier of a purchase, typed by NAME with smart entry (ADR-0099 §7): the names used before are
 * suggested, and another spelling of an existing one gets a non-blocking "use X instead?" hint. Saving
 * resolves the name — an existing supplier is linked, a new name creates the supplier inline, and when
 * several suppliers share the name the operator picks which (names are not unique, D-D). Below the input
 * the field says which of those will happen.
 */
export function SupplierField({
  id,
  value,
  onValueChange,
  chosenId,
  onChosenIdChange,
  current,
  error,
}: {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  chosenId: string;
  onChosenIdChange: (id: string) => void;
  /** The purchase's own supplier, kept while the text reads its name. */
  current: { id: string; name: string } | null;
  error?: string;
}) {
  const t = useTranslations("purchases.form");
  const candidates = useSuggestions("supplierName", value);
  const name = useDebouncedValue(value.trim(), 300);
  const { data } = useSuppliers(
    { q: name, limit: MAX_PAGE_LIMIT, sort: "name", dir: "asc" },
    { enabled: name !== "" },
  );
  const resolution: SupplierResolution | null = useMemo(() => {
    if (value.trim() === "") return { kind: "none" };
    if (current && current.name.trim() === value.trim()) return { kind: "existing", id: current.id };
    if (name !== value.trim() || !data) return null;
    return resolveSupplier(value, data.items, current, chosenId);
  }, [value, name, data, current, chosenId]);

  const choices = resolution?.kind === "ambiguous" ? resolution.choices : null;
  // Keep the pick visible after it resolves the ambiguity.
  const sameNamed = useMemo(
    () => (data?.items ?? []).filter((s) => s.name.trim() === value.trim()),
    [data, value],
  );

  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{t("supplier")}</FieldLabel>
      <SuggestInput
        id={id}
        value={value}
        onValueChange={(next) => {
          onValueChange(next);
          onChosenIdChange("");
        }}
        source={() => candidates}
        recentKey="purchase.supplier"
        placeholder={t("supplierPlaceholder")}
        aria-invalid={error ? true : undefined}
      />
      {resolution?.kind === "new" ? (
        <FieldDescription>{t("supplierNew", { name: resolution.name })}</FieldDescription>
      ) : null}
      {choices || (sameNamed.length > 1 && chosenId) ? (
        <div className="space-y-1.5">
          <p className="text-sm text-muted-foreground">{t("supplierAmbiguous")}</p>
          <Select value={chosenId || undefined} onValueChange={onChosenIdChange}>
            <SelectTrigger className="w-full" aria-label={t("supplierAmbiguousLabel")}>
              <SelectValue placeholder={t("supplierAmbiguousPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {(choices ?? sameNamed).map((supplier) => (
                <SelectItem key={supplier.id} value={supplier.id}>
                  {supplierChoiceLabel(supplier)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}
