import { describe, expect, test } from "bun:test";
import { hasUnsavedChanges, registerUnsavedChanges } from "./unsaved-changes";

describe("unsaved-changes registry", () => {
  test("is clean until a guard registers, and after every guard releases", () => {
    expect(hasUnsavedChanges()).toBe(false);
    const a = registerUnsavedChanges();
    const b = registerUnsavedChanges();
    expect(hasUnsavedChanges()).toBe(true);
    a();
    expect(hasUnsavedChanges()).toBe(true);
    b();
    expect(hasUnsavedChanges()).toBe(false);
  });

  test("releasing twice does not clear another guard", () => {
    const a = registerUnsavedChanges();
    const b = registerUnsavedChanges();
    a();
    a();
    expect(hasUnsavedChanges()).toBe(true);
    b();
    expect(hasUnsavedChanges()).toBe(false);
  });
});
