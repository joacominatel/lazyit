/**
 * Pure helpers for the mapping step's "use as custom field" shortcut (#1050): turn an ignored
 * column into a custom field seeded with the column's own header as the field name, so the
 * operator never has to type it. Kept standalone (no JSX, no hooks) so the click math is
 * unit-testable without a component test harness (frontend component/e2e tests are deferred,
 * ADR-0012) — see `mapping-shortcuts.test.ts`.
 *
 * This does NOT bypass any validation: it seeds the exact same `ColumnChoice` shape the operator
 * would produce by hand, so the existing reserved-key / duplicate-key / cap checks in
 * `mapping-step.tsx`'s `columnError` memo still run against it unchanged.
 */

/** Target token: where a column's value goes. `__ignore__` drops it, `__custom__` → specs, else `entity:field`. */
export const IGNORE = "__ignore__";
export const CUSTOM = "__custom__";

/** Per-column state: the chosen target token + (for `__custom__`) the operator-named specs key. */
export type ColumnChoice = { target: string; customName: string };

/** `customName` is trimmed 1..100 server-side (`packages/shared/.../import/mapping.ts:67`, `Input
 *  maxLength={100}`) — clamp here so an oversized header can't silently fail validation later. */
const CUSTOM_NAME_MAX = 100;

/** Build the choice for "use this ignored column's header as its custom field name". */
export function customChoiceFromHeader(header: string): ColumnChoice {
  return { target: CUSTOM, customName: header.slice(0, CUSTOM_NAME_MAX) };
}

/** Apply the shortcut to every column currently `IGNORE`d ("apply to all ignored" — issue #1050's
 *  bulk affordance). Columns already mapped elsewhere (a native field, or already custom) are left
 *  untouched, so this never clobbers a choice the operator already made. */
export function applyCustomShortcutToIgnored(
  headers: string[],
  choices: Record<string, ColumnChoice>,
): Record<string, ColumnChoice> {
  const next = { ...choices };
  for (const header of headers) {
    if (next[header]?.target === IGNORE) {
      next[header] = customChoiceFromHeader(header);
    }
  }
  return next;
}
