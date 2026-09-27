/**
 * The unsaved-changes registry (frontend.md Fork D3). The App Router has no navigation guard, so an
 * in-app `router.push` silently discards a half-filled form. Screens that guard a hard navigation with
 * `useBeforeUnloadGuard` also register here, and the chat asks before it navigates on its own: with any
 * guard active it shows an "Open" link instead of moving the user.
 *
 * Module-level on purpose — one browser tab, one registry — and token-based so two guarded forms on the
 * same screen cannot clear each other.
 */

const active = new Set<symbol>();

/** Registers one active guard; call the returned function to release it (idempotent). */
export function registerUnsavedChanges(): () => void {
  const token = Symbol("unsaved-changes");
  active.add(token);
  return () => {
    active.delete(token);
  };
}

/** Whether any screen currently holds unsaved edits. */
export function hasUnsavedChanges(): boolean {
  return active.size > 0;
}
