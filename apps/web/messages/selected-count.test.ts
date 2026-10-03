import { describe, expect, test } from "bun:test";
import { createTranslator } from "next-intl";
import { ENTITY_KEYS } from "@/lib/entity-key";
import enShared from "./en/shared.json";
import esShared from "./es/shared.json";

/**
 * The bulk-action bar's count label (`shared.table.selectedCount`, #1512). ICU replaces `#` only directly
 * inside a `plural` branch: nested one level down, inside the `{entity, select, …}`, it is a literal, and
 * the Spanish bar read "# activos seleccionados" for every list. Formats every entity in both locales
 * through next-intl, as the bar does.
 */

const CATALOGS = { en: enShared, es: esShared } as const;

function selectedCount(locale: keyof typeof CATALOGS, count: number, entity: string) {
  const t = createTranslator({
    locale,
    messages: { shared: CATALOGS[locale] },
    namespace: "shared.table",
  });
  return t("selectedCount", { count, entity });
}

describe("bulk-action bar selected count (#1512)", () => {
  for (const locale of Object.keys(CATALOGS) as (keyof typeof CATALOGS)[]) {
    for (const entity of ENTITY_KEYS) {
      test(`${locale} · ${entity} renders the number, never a literal #`, () => {
        for (const count of [1, 10, 1234]) {
          const label = selectedCount(locale, count, entity);
          expect(label).not.toContain("#");
          expect(label).toMatch(/^\d[\d.,]*\s/);
        }
      });
    }
  }

  test("reads as a sentence in each locale", () => {
    expect(selectedCount("en", 10, "asset")).toBe("10 assets selected");
    expect(selectedCount("es", 10, "asset")).toBe("10 activos seleccionados");
    expect(selectedCount("es", 1, "application")).toBe("1 aplicación seleccionada");
    expect(selectedCount("es", 0, "asset")).toBe("Ningún activo seleccionado");
  });
});
