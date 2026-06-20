import { describe, expect, test } from "bun:test";
import { HEADER_ALIASES, IMPORT_UI_TARGETS } from "./descriptor";

/**
 * HEADER_ALIASES auto-detection (ADR-0069 column intelligence, #647). The assisted mapping step seeds a
 * column's target when its NORMALIZED header equals a field name OR one of its aliases. This guards that
 * the real snipe-it/Spanish headers from a live export resolve to the right target — so the operator
 * doesn't have to hand-map (and miss the non-obvious `person:name` / `asset:modelId`, the #647 regression).
 */

// Same normalization the mapping step applies (case-fold + strip non-alphanumerics — accents drop too).
const normalize = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Resolve a source header to its target token via field-name OR alias match (mirrors the seed). */
function resolveTarget(header: string): string | null {
  const norm = normalize(header);
  for (const group of ["asset", "model", "person"] as const) {
    for (const f of IMPORT_UI_TARGETS[group]) {
      const token = `${group}:${f.field}`;
      if (normalize(f.field) === norm) return token;
      if (HEADER_ALIASES[token]?.some((a) => normalize(a) === norm)) return token;
    }
  }
  return null;
}

describe("HEADER_ALIASES — Spanish/snipe-it auto-detection", () => {
  // The headers that actually shipped in the CEO's real export (prueba-import1.csv).
  test.each([
    ["Nombre del activo", "asset:name"],
    ["Número de serie", "asset:serial"],
    ["Placa del activo", "asset:assetTag"],
    ["Estado", "asset:status"],
    ["Modelo", "asset:modelId"],
    ["Ubicación", "asset:locationId"],
    ["Categoría", "model:category"],
    ["Fabricante", "model:manufacturer"],
    ["Asignado a", "person:name"], // the #647 killer — must auto-map so assignment works
    ["Email", "person:email"],
    ["Username", "person:username"],
    ["Employee No.", "person:legajo"],
    ["Cargo", "person:jobTitle"],
    ["Departamento", "person:department"],
    ["Supervisor", "person:supervisor"],
  ])("'%s' → %s", (header, expected) => {
    expect(resolveTarget(header)).toBe(expected);
  });

  test("'Modelo No.' does NOT collide with 'Modelo' (exact-after-normalize only)", () => {
    // "Modelo No." has no target — it must stay unmapped, never steal asset:modelId from "Modelo".
    expect(resolveTarget("Modelo No.")).toBeNull();
  });

  test("plain English field names still auto-map (alias is additive, not a replacement)", () => {
    expect(resolveTarget("name")).toBe("asset:name");
    expect(resolveTarget("status")).toBe("asset:status");
  });
});
