import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import en from "@/messages/en/ai.json";
import es from "@/messages/es/ai.json";
import { fieldLabelRef, toolNameKey } from "./tool-labels";

/**
 * Catalog coverage (issue #1377). The API's tool registry is pinned by its catalog golden
 * (`apps/api/src/ai/core/tool-catalog.golden.spec.ts`), and its approval previews name their fields in
 * the tool sources. Both are read here AS TEXT — the web never imports the API — so a tool or preview
 * field added on the server without an en + es label fails this test instead of reaching a Spanish
 * screen in English.
 */

const API_AI = fileURLToPath(new URL("../../../api/src/ai/", import.meta.url));

function goldenToolNames(): string[] {
  const source = readFileSync(`${API_AI}core/tool-catalog.golden.spec.ts`, "utf8");
  const start = source.indexOf("const GOLDEN = {");
  const end = source.indexOf("\n};", start);
  expect(start).toBeGreaterThan(-1);
  const block = source.slice(start, end);
  return [...block.matchAll(/^ {2}([a-z][a-z0-9_]*): \{$/gm)].map((m) => m[1]!);
}

/** Every literal `field: '…'` a tool's preview writes (spec files excluded). */
function literalPreviewFields(): string[] {
  const fields = new Set<string>();
  for (const dir of ["tools", "core"]) {
    for (const file of readdirSync(`${API_AI}${dir}`)) {
      if (!file.endsWith(".ts") || file.includes(".spec.") || file.includes("spec.ts")) continue;
      const source = readFileSync(`${API_AI}${dir}/${file}`, "utf8");
      for (const m of source.matchAll(/field: '([A-Za-z][A-Za-z0-9]*)'/g)) fields.add(m[1]!);
    }
  }
  return [...fields];
}

/**
 * Fields a preview takes from a tool's input keys rather than a literal (`createdFields(input)`, the
 * scalar/writable field lists of asset_*, application_*, consumable_*, location_create, user_*).
 */
const INPUT_DERIVED_FIELDS = [
  "assetTag",
  "serial",
  "company",
  "purchaseDate",
  "warrantyEnd",
  "purchaseCost",
  "usefulLifeMonths",
  "salvageValue",
  "specs",
  "manufacturer",
  "sku",
  "address",
  "floor",
  "categoryId",
  "url",
  "vendor",
  "seatsPurchased",
  "costPerSeat",
  "renewalDate",
  "minStock",
  "unit",
];

/** The `action` row is the card's sentence, not a field row. */
const NOT_A_FIELD_ROW = new Set(["action"]);

const catalogs = { en, es } as const;

describe("tool name labels", () => {
  test.skipIf(!existsSync(API_AI))("every registered tool has an en and es label", () => {
    const tools = goldenToolNames();
    expect(tools.length).toBeGreaterThan(40);
    for (const [lang, messages] of Object.entries(catalogs)) {
      const missing = tools.filter((name) => !(name in messages.toolNames));
      expect({ lang, missing }).toEqual({ lang, missing: [] });
    }
  });

  test("en and es label the same tools, with non-empty text", () => {
    expect(Object.keys(es.toolNames).sort()).toEqual(Object.keys(en.toolNames).sort());
    for (const messages of Object.values(catalogs)) {
      for (const [name, label] of Object.entries(messages.toolNames)) {
        expect(toolNameKey(name)).toBe(name);
        expect(label.trim()).not.toBe("");
      }
    }
  });

  test("a name that is not a tool name is never used as a message key", () => {
    expect(toolNameKey("asset_search")).toBe("asset_search");
    expect(toolNameKey("Asset.Search")).toBeNull();
    expect(toolNameKey("")).toBeNull();
  });
});

describe("preview field labels", () => {
  test.skipIf(!existsSync(API_AI))("every field a preview writes has an en and es label", () => {
    const fields = [...new Set([...literalPreviewFields(), ...INPUT_DERIVED_FIELDS])].filter(
      (f) => !NOT_A_FIELD_ROW.has(f),
    );
    expect(fields.length).toBeGreaterThan(40);
    for (const [lang, messages] of Object.entries(catalogs)) {
      const missing = fields.filter((field) => !(field in messages.fields));
      expect({ lang, missing }).toEqual({ lang, missing: [] });
    }
  });

  test("en and es label the same fields, and both template the prefixed paths", () => {
    expect(Object.keys(es.fields).sort()).toEqual(Object.keys(en.fields).sort());
    for (const messages of Object.values(catalogs)) {
      expect(messages.fieldPrefixes.input).toContain("{name}");
      expect(messages.fieldPrefixes.specs).toContain("{name}");
    }
  });

  test("resolves a field path to a key, a templated prefix, or the humanized fallback", () => {
    expect(fieldLabelRef("isActive")).toEqual({ kind: "key", key: "isActive" });
    expect(fieldLabelRef("input.reason")).toEqual({ kind: "prefixed", prefix: "input", name: "reason" });
    expect(fieldLabelRef("specs.ram")).toEqual({ kind: "prefixed", prefix: "specs", name: "ram" });
    expect(fieldLabelRef("specs.cpu.cores")).toEqual({ kind: "prefixed", prefix: "specs", name: "cpu.cores" });
    expect(fieldLabelRef("specs.")).toEqual({ kind: "none" });
    expect(fieldLabelRef("other.thing")).toEqual({ kind: "none" });
    expect(fieldLabelRef("has space")).toEqual({ kind: "none" });
  });
});
