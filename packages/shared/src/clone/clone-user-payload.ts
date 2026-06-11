/**
 * Pure builders for the user create/edit + clone wizard (ADR-0058) — the web↔api logic that turns a
 * form's loose values into the validated wire shapes (`ManagerInput`, `CloneUser`). They live here (the
 * canonical home for clone/create-mapping logic, beside `clone-defaults.ts`) so the form and its unit
 * tests share ONE definition, and so the XOR / id-list normalization is never re-implemented per call site.
 *
 * Nothing here talks to the network or React — they are deterministic mappers over plain values.
 */

import type { ManagerInput } from "../schemas/user";

/**
 * The two mutually-exclusive ways a form expresses a manager (ADR-0058, the `users_manager_at_most_one`
 * XOR): a linked lazyit user (`managerId`), OR a free-text name (`managerName`). The wizard tracks a
 * single discriminator (`kind`) plus the value for whichever side is active, so the UI can never hold
 * both at once. `"none"` means "no manager recorded".
 */
export type ManagerFormValue =
  | { kind: "none" }
  | { kind: "user"; managerId: string }
  | { kind: "external"; managerName: string };

/**
 * Map the form's manager discriminator to the wire `manager` field of a create/clone/update payload:
 *   - `"none"`     → `null` (clear / no manager) — the explicit, contract-valid "no manager".
 *   - `"user"`     → `{ managerId }` when an id is chosen; an empty id collapses to `null` (nothing picked).
 *   - `"external"` → `{ managerName }` when the name is non-blank (trimmed); a blank name collapses to `null`.
 *
 * Returns `null` (never `{}`) when nothing is set, so the payload mirrors the DB CHECK exactly: a value
 * is EITHER one side OR the other OR cleared, never both and never an empty object that `ManagerInputSchema`
 * would still accept as "no change". The build always emits a concrete decision (set or clear).
 */
export function toManagerInput(value: ManagerFormValue): ManagerInput | null {
  if (value.kind === "user") {
    const id = value.managerId.trim();
    return id ? { managerId: id } : null;
  }
  if (value.kind === "external") {
    const name = value.managerName.trim();
    return name ? { managerName: name } : null;
  }
  return null;
}

/**
 * Project a READ-side manager descriptor (`UserSchema.manager`) back to a `ManagerFormValue` so the EDIT
 * form opens pre-set to whatever the user currently has. A linked manager that is OFFBOARDED
 * (`isOffboarded`) is still shown as the linked user (so a save without touching it is a no-op), never
 * silently dropped — the form surfaces the "former manager" treatment alongside.
 */
export function managerDescriptorToFormValue(
  manager:
    | { type: "user"; id: string }
    | { type: "external"; name: string }
    | null,
): ManagerFormValue {
  if (manager === null) return { kind: "none" };
  if (manager.type === "user")
    return { kind: "user", managerId: manager.id };
  return { kind: "external", managerName: manager.name };
}

/**
 * De-duplicate + drop blanks from a checklist's selected ids (ADR-0058 clone schema requires uniqueness).
 * The wizard tracks selections in a `Set`, but a defensive normalize here keeps the builder honest if a
 * caller passes a raw array — the order of first appearance is preserved for a stable payload.
 */
export function dedupeIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
