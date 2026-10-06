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
import { useCreateSupplier, useSuppliers } from "@/lib/api/hooks/use-suppliers";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { resolveSupplier, type SupplierResolution } from "@/lib/purchases/supplier";

/**
 * Every supplier whose name contains `name`, for resolving it on save (the exact match is picked there).
 * Reads page after page, so a same-named supplier past the first page is never missed.
 */
export async function findSuppliersNamed(name: string): Promise<Supplier[]> {
  const found: Supplier[] = [];
  for (;;) {
    const page = await getSuppliers({
      q: name.trim(),
      limit: MAX_PAGE_LIMIT,
      offset: found.length,
      sort: "name",
      dir: "asc",
    });
    found.push(...page.items);
    if (page.items.length === 0 || found.length >= page.total) return found;
  }
}

/** The longest tax ID a supplier stores; a longer one read from a document is left out, never cut. */
const TAX_ID_MAX = 50;

/**
 * Resolve a typed supplier name to an id when saving (#1477, the same rule as the purchase form): nothing
 * typed is no supplier; one live supplier with that exact name — or the one picked among same-named ones —
 * is linked; a new name creates the supplier, with the tax ID when one is given (read from a document);
 * several with the name and none picked is `"ambiguous"`, for the field to ask. `created` names a supplier
 * made here, for the toast.
 */
export function useSupplierSaver(): (
  text: string,
  chosenId: string,
  taxId?: string | null,
) => Promise<{ id: string | null; created: string | null } | "ambiguous"> {
  const createSupplier = useCreateSupplier();
  return async (text, chosenId, taxId) => {
    if (text.trim() === "") return { id: null, created: null };
    const resolution = resolveSupplier(text, await findSuppliersNamed(text), null, chosenId);
    switch (resolution.kind) {
      case "none":
        return { id: null, created: null };
      case "existing":
        return { id: resolution.id, created: null };
      case "ambiguous":
        return "ambiguous";
      case "new": {
        const tax = taxId?.trim();
        const created = await createSupplier.mutateAsync({
          name: resolution.name,
          ...(tax && tax.length <= TAX_ID_MAX ? { taxId: tax } : {}),
        });
        return { id: created.id, created: created.name };
      }
    }
  };
}

/**
 * How the typed supplier name resolves right now (`null` while the lookup for this text is in flight),
 * and the suppliers that carry exactly that name. The purchase form reads it to hint at a repeated
 * reference; the field shows it.
 */
export function useSupplierResolution(
  value: string,
  current: { id: string; name: string } | null,
  chosenId: string,
): { resolution: SupplierResolution | null; sameNamed: Supplier[] } {
  const name = useDebouncedValue(value.trim(), 300);
  const isCurrent = current !== null && current.name.trim() === value.trim();
  const { data } = useSuppliers(
    { q: name, limit: MAX_PAGE_LIMIT, sort: "name", dir: "asc" },
    { enabled: name !== "" && !isCurrent },
  );
  return useMemo(() => {
    const sameNamed = (data?.items ?? []).filter((s) => s.name.trim() === value.trim());
    if (value.trim() === "") return { resolution: { kind: "none" }, sameNamed };
    if (isCurrent) return { resolution: { kind: "existing", id: current.id }, sameNamed };
    if (name !== value.trim() || !data) return { resolution: null, sameNamed };
    return { resolution: resolveSupplier(value, data.items, current, chosenId), sameNamed };
  }, [value, name, data, current, chosenId, isCurrent]);
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
  resolution,
  sameNamed,
  error,
}: {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  chosenId: string;
  onChosenIdChange: (id: string) => void;
  /** From {@link useSupplierResolution}, which the form owns. */
  resolution: SupplierResolution | null;
  sameNamed: Supplier[];
  error?: string;
}) {
  const t = useTranslations("purchases.form");
  const candidates = useSuggestions("supplierName", value);
  const choices = resolution?.kind === "ambiguous" ? resolution.choices : null;

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
