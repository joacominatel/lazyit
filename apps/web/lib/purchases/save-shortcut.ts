/**
 * Ctrl+Enter (⌘+Enter on a Mac) saves the purchase form (ADR-0099 Phase 1 web, #1508). Pure, so the
 * keyboard model is tested without a DOM.
 *
 * The form listens for its own fields, which covers every input, textarea and smart-entry field — and the
 * lists its comboboxes open in a portal, because React bubbles through portals. A smart-entry field with
 * its list open handles the same keys first (Ctrl/⌘+Enter keeps the text as typed, `suggestKeyAction`) and
 * lets the key travel on, so the save follows; the form therefore never skips a key a field already
 * handled. What the form cannot hear is a key pressed with focus on nothing — after a click on blank space,
 * or once the focused control is gone (a removed line). The document catches that case only, and only when
 * the last click was on the page the form is on (its `<main>`), or there was none yet: a click into the
 * docked assistant's transcript also leaves focus on nothing, and a Ctrl/⌘+Enter there is not a save. Focus
 * in anything else (a dialog, the assistant, the search palette) is somebody else's keyboard.
 */

/** The parts of a keyboard event the shortcut reads — a DOM `KeyboardEvent` fits as is. */
export interface ShortcutKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

/** Ctrl+Enter or ⌘+Enter, whatever else is held — never while an input method is composing text. */
export function isSaveShortcut(event: ShortcutKeyEvent): boolean {
  return event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing;
}

/** Whether a key press reached the document with focus on nothing: the page body (or no target at all). */
export function isUnfocusedTarget(
  target: unknown,
  doc: { body: unknown; documentElement: unknown },
): boolean {
  return target == null || target === doc.body || target === doc.documentElement;
}

/**
 * Whether the last pointer press leaves a focus-on-nothing shortcut to the form: no press since the form
 * mounted, or one inside `scope` (the `<main>` the form is on).
 */
export function lastPointerInScope(
  lastPointer: unknown,
  scope: { contains(node: Node | null): boolean },
): boolean {
  return lastPointer == null || scope.contains(lastPointer as Node);
}
