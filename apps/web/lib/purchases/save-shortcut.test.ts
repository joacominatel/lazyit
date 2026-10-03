import { describe, expect, test } from "bun:test";
import { suggestKeyAction } from "@/lib/utils/suggest";
import { isSaveShortcut, isUnfocusedTarget, lastPointerInScope } from "./save-shortcut";

/**
 * Ctrl/⌘+Enter saves the purchase form (#1508). The keyboard model only — there is no DOM runner
 * (ADR-0012); the wiring is `onFormKeyDown` and the document listener in `purchase-form.tsx`.
 */
const key = (over: Partial<Parameters<typeof isSaveShortcut>[0]> = {}) => ({
  key: "Enter",
  ctrlKey: false,
  metaKey: false,
  isComposing: false,
  ...over,
});

describe("the save shortcut", () => {
  test("is Ctrl+Enter, and ⌘+Enter on a Mac, from a plain input", () => {
    expect(isSaveShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isSaveShortcut(key({ metaKey: true }))).toBe(true);
  });

  test("is not plain Enter (that adds a line), another ⌘ key, or Enter while an IME composes", () => {
    expect(isSaveShortcut(key())).toBe(false);
    expect(isSaveShortcut(key({ key: "j", metaKey: true }))).toBe(false);
    expect(isSaveShortcut(key({ metaKey: true, isComposing: true }))).toBe(false);
  });

  test("a smart-entry field with its list open keeps the text on Ctrl/⌘+Enter, and the same keys are the save shortcut", () => {
    // The field handles the key first and marks it handled; the form must not take that as "skip".
    const field = suggestKeyAction("Enter", { open: true, active: 0, count: 2, modKey: true });
    expect(field).toEqual({ type: "keep", preventDefault: true });
    expect(isSaveShortcut(key({ metaKey: true }))).toBe(true);
  });

  test("the document takes the key only with focus on nothing — the page body", () => {
    const body = { tag: "body" };
    const html = { tag: "html" };
    const doc = { body, documentElement: html };
    expect(isUnfocusedTarget(body, doc)).toBe(true);
    expect(isUnfocusedTarget(html, doc)).toBe(true);
    expect(isUnfocusedTarget(null, doc)).toBe(true);
    // A focused control anywhere else (the form's own fields reach it through React; a dialog or the
    // assistant is somebody else's keyboard).
    expect(isUnfocusedTarget({ tag: "input" }, doc)).toBe(false);
  });

  test("with focus on nothing, it saves only after a click on the form's page, or before any click", () => {
    const inside = { tag: "div" };
    const panel = { tag: "ai-transcript" };
    const main = { contains: (node: unknown) => node === inside };
    expect(lastPointerInScope(null, main)).toBe(true);
    expect(lastPointerInScope(inside, main)).toBe(true);
    expect(lastPointerInScope(panel, main)).toBe(false);
  });
});
