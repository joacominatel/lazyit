import { describe, expect, test } from "bun:test";

import en from "../messages/en/shared.json";
import es from "../messages/es/shared.json";
import { actionLabel, actionTone } from "./activity-tones";

/** A next-intl-shaped translator over one locale's `shared.activity.action` catalog. */
function translator(catalog: Record<string, string>) {
  const t = (key: string) => catalog[key];
  t.has = (key: string) => key in catalog;
  return t;
}

// Issue #1375: a user deactivated / reactivated (via the UI, the API or the AI) now surfaces in Reports →
// Users as the `deactivated` / `reactivated` verbs — tinted and localized, not the generic fallback.
describe("activation verbs (issue #1375)", () => {
  test("deactivated reads as danger, reactivated as success", () => {
    expect(actionTone("deactivated")).toBe("danger");
    expect(actionTone("reactivated")).toBe("success");
  });

  test("both verbs are localized in en and es", () => {
    const enT = translator(en.activity.action);
    const esT = translator(es.activity.action);
    expect(actionLabel("deactivated", enT)).toBe("Deactivated");
    expect(actionLabel("reactivated", enT)).toBe("Reactivated");
    expect(actionLabel("deactivated", esT)).toBe("Desactivado");
    expect(actionLabel("reactivated", esT)).toBe("Reactivado");
  });
});

// Issue #1420: a user ending one of their sessions surfaces as `session_ended` — tinted and localized.
describe("session_ended (issue #1420)", () => {
  test("reads as info and is localized in en and es", () => {
    expect(actionTone("session_ended")).toBe("info");
    expect(actionLabel("session_ended", translator(en.activity.action))).toBe("Session ended");
    expect(actionLabel("session_ended", translator(es.activity.action))).toBe("Sesión cerrada");
  });
});
