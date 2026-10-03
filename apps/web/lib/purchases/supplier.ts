/**
 * Suppliers in the purchase form and the supplier form (ADR-0099 §2) — pure. Names and tax IDs are not
 * unique (CEO decision D-D): the purchase form types a supplier's NAME with smart entry and resolves it to
 * a supplier when saving, creating one inline when the name is new. A likely duplicate is a hint, never a
 * refusal.
 */

import { type CreateSupplier, type Supplier, SUPPLIER_MERGE_FIELDS, type UpdateSupplier } from "@lazyit/shared";

/** How the supplier name typed on a purchase resolves. */
export type SupplierResolution =
  /** Nothing typed: the purchase has no supplier. */
  | { kind: "none" }
  /** Exactly one live supplier has this name (or it is the purchase's own, unchanged). */
  | { kind: "existing"; id: string }
  /** Several suppliers share this name: the operator picks one (`choices`, newest first as listed). */
  | { kind: "ambiguous"; choices: Supplier[] }
  /** No supplier has this name: saving creates it. */
  | { kind: "new"; name: string };

/**
 * Resolve the typed name against the suppliers a search returned (`matches` — any that merely contain
 * the text are ignored: only the exact, trimmed name counts). The purchase's own supplier is kept while the
 * text still reads its name, even when it is archived and no search returns it. `chosenId` is the
 * operator's pick among same-named suppliers.
 */
export function resolveSupplier(
  text: string,
  matches: readonly Supplier[],
  current?: { id: string; name: string } | null,
  chosenId?: string,
): SupplierResolution {
  const name = text.trim();
  if (name === "") return { kind: "none" };
  if (current && current.name.trim() === name) return { kind: "existing", id: current.id };
  const exact = matches.filter((s) => s.name.trim() === name);
  if (exact.length === 0) return { kind: "new", name };
  if (exact.length === 1) return { kind: "existing", id: exact[0]!.id };
  const chosen = exact.find((s) => s.id === chosenId);
  return chosen ? { kind: "existing", id: chosen.id } : { kind: "ambiguous", choices: exact };
}

/** Another live supplier already holding this tax ID — the strongest duplicate hint (ADR-0099 §2). */
export function taxIdOwner(
  taxId: string,
  matches: readonly Supplier[],
  selfId?: string,
): Supplier | null {
  const wanted = taxId.trim().toLowerCase();
  if (wanted === "") return null;
  return (
    matches.find((s) => s.id !== selfId && (s.taxId ?? "").trim().toLowerCase() === wanted) ?? null
  );
}

/** The supplier form's values: text, `""` (or undefined) for blank. */
export type SupplierDraft = { name: string } & Partial<Record<SupplierTextField, string>>;

/** Every optional text field — the shared list a merge fills (the supplier's fields minus the name). */
const SUPPLIER_TEXT_FIELDS = SUPPLIER_MERGE_FIELDS;
type SupplierTextField = (typeof SUPPLIER_TEXT_FIELDS)[number];

/** A saved supplier → the form values. */
export function supplierDraftFrom(supplier?: Supplier): SupplierDraft {
  const draft: SupplierDraft = { name: supplier?.name ?? "" };
  for (const field of SUPPLIER_TEXT_FIELDS) draft[field] = supplier?.[field] ?? undefined;
  return draft;
}

/** The create payload: the name plus every filled field (trimmed). */
export function toCreateSupplier(draft: SupplierDraft): CreateSupplier {
  const out: CreateSupplier = { name: draft.name.trim() };
  for (const field of SUPPLIER_TEXT_FIELDS) {
    const value = draft[field]?.trim();
    if (value) out[field] = value;
  }
  return out;
}

/** The update payload: only the changed fields, a cleared one as `null`; `null` when nothing changed. */
export function toUpdateSupplier(draft: SupplierDraft, original: Supplier): UpdateSupplier | null {
  const out: UpdateSupplier = {};
  const name = draft.name.trim();
  if (name !== original.name) out.name = name;
  for (const field of SUPPLIER_TEXT_FIELDS) {
    const value = draft[field]?.trim() || null;
    if (value !== original[field]) out[field] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}
