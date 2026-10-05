import { describe, expect, test } from "bun:test";
import {
  type AssetStatusLabel,
  CreateAssetStatusLabelSchema,
  UpdateAssetStatusLabelSchema,
} from "@lazyit/shared";
import {
  buildCreateStatusLabel,
  buildUpdateStatusLabel,
  STATUS_COLOR_PALETTE,
  toStatusLabelFormValues,
} from "./asset-status-label-form";

const LABEL: AssetStatusLabel = {
  id: "clloaner0000000000000000",
  name: "Loaner pool",
  kind: "IN_STORAGE",
  color: "#2563EB",
  description: "Spare laptops lent short-term",
  order: 2,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  deletedAt: null,
  assetCount: 4,
};

describe("buildCreateStatusLabel", () => {
  test("trims, omits blank optional fields, and is valid per the shared schema", () => {
    const result = buildCreateStatusLabel({
      name: "  On the bench ",
      kind: "IN_MAINTENANCE",
      color: "",
      description: "  ",
      order: "",
    });
    expect(result).toEqual({ ok: true, body: { name: "On the bench", kind: "IN_MAINTENANCE" } });
    if (result.ok) expect(CreateAssetStatusLabelSchema.safeParse(result.body).success).toBe(true);
  });

  test("carries colour (upper-cased), description and order", () => {
    const result = buildCreateStatusLabel({
      name: "Loaner pool",
      kind: "IN_STORAGE",
      color: "#2563eb",
      description: "Spare laptops",
      order: "3",
    });
    expect(result).toEqual({
      ok: true,
      body: {
        name: "Loaner pool",
        kind: "IN_STORAGE",
        color: "#2563EB",
        description: "Spare laptops",
        order: 3,
      },
    });
  });

  test("names the mistake instead of sending it", () => {
    const base = toStatusLabelFormValues(undefined, "LOST");
    expect(buildCreateStatusLabel(base)).toEqual({ ok: false, error: "nameRequired" });
    expect(buildCreateStatusLabel({ ...base, name: "X", color: "blue" })).toEqual({
      ok: false,
      error: "colorInvalid",
    });
    expect(buildCreateStatusLabel({ ...base, name: "X", order: "-1" })).toEqual({
      ok: false,
      error: "orderInvalid",
    });
    expect(buildCreateStatusLabel({ ...base, name: "X", order: "1.5" })).toEqual({
      ok: false,
      error: "orderInvalid",
    });
  });
});

describe("buildUpdateStatusLabel", () => {
  test("an untouched form sends nothing (and never the kind)", () => {
    expect(buildUpdateStatusLabel(LABEL, toStatusLabelFormValues(LABEL))).toEqual({
      ok: true,
      body: null,
    });
  });

  test("only the changed fields travel; a cleared optional field is null", () => {
    const result = buildUpdateStatusLabel(LABEL, {
      ...toStatusLabelFormValues(LABEL),
      name: "Loaners",
      color: "",
      order: "",
    });
    expect(result).toEqual({ ok: true, body: { name: "Loaners", color: null, order: null } });
    if (result.ok) expect(UpdateAssetStatusLabelSchema.safeParse(result.body).success).toBe(true);
  });

  test("a kind change is sent only when the kind actually changed", () => {
    expect(
      buildUpdateStatusLabel(LABEL, { ...toStatusLabelFormValues(LABEL), kind: "RETIRED" }),
    ).toEqual({ ok: true, body: { kind: "RETIRED" } });
  });

  test("a stored lower-case colour is not a change when re-saved", () => {
    const lower = { ...LABEL, color: "#2563eb" };
    expect(buildUpdateStatusLabel(lower, toStatusLabelFormValues(lower))).toEqual({
      ok: true,
      body: null,
    });
  });
});

test("every palette colour is a valid #RRGGBB", () => {
  for (const color of STATUS_COLOR_PALETTE) {
    expect(/^#[0-9A-F]{6}$/.test(color)).toBe(true);
  }
});
