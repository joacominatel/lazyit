import { describe, expect, test } from "bun:test";
import {
  buildFiltersPatch,
  buildNextUrl,
  multiFilterPatch,
  singleFilterPatch,
} from "./list-params-url";

/**
 * Regression coverage for #217: the "Linked only" toggle could be turned on but not off because the
 * off-handler fired TWO `router.replace` writes from one event, and the second re-emitted a stale
 * snapshot that re-introduced the param the first one removed (last-write-wins). The fix routes both
 * keys through ONE patch → one navigation. These tests pin the atomicity of that patch path: a
 * single handler that changes two filters must drop NEITHER. (No `useListParams` test existed.)
 */

const KB_DEFAULTS = { status: "", categoryId: "", linked: "ALL", linkedTo: "" };

describe("buildNextUrl", () => {
  test("applies a two-key patch in one pass (no last-write-wins)", () => {
    // The #217 scenario: URL has linked=only & linkedTo=asset; the toggle-off patch clears BOTH.
    const href = buildNextUrl("linked=only&linkedTo=asset", "/kb", {
      linked: undefined,
      linkedTo: undefined,
    });
    expect(href).toBe("/kb");
  });

  test("clears a key with undefined and another with empty string, together", () => {
    const href = buildNextUrl("linked=only&linkedTo=asset&q=vpn", "/kb", {
      linked: undefined,
      linkedTo: "",
    });
    // q is untouched; both linked and linkedTo are gone in the same write.
    expect(href).toBe("/kb?q=vpn");
  });

  test("sets two keys at once", () => {
    const href = buildNextUrl("", "/informes", { from: "2026-01-01", to: "2026-02-01" });
    const params = new URL(`http://x${href}`).searchParams;
    expect(params.get("from")).toBe("2026-01-01");
    expect(params.get("to")).toBe("2026-02-01");
  });

  test("preserves unrelated existing params", () => {
    const href = buildNextUrl("tab=assets&action=create", "/informes", {
      from: "2026-01-01",
      to: "2026-02-01",
    });
    const params = new URL(`http://x${href}`).searchParams;
    expect(params.get("tab")).toBe("assets");
    expect(params.get("action")).toBe("create");
    expect(params.get("from")).toBe("2026-01-01");
    expect(params.get("to")).toBe("2026-02-01");
  });

  test("returns bare pathname when the resulting query is empty", () => {
    expect(buildNextUrl("linked=only", "/kb", { linked: undefined })).toBe("/kb");
  });

  test("stringifies numeric values (e.g. offset)", () => {
    expect(buildNextUrl("", "/kb", { offset: 50 })).toBe("/kb?offset=50");
  });
});

describe("singleFilterPatch", () => {
  test("clears the key when value equals the filter default", () => {
    expect(singleFilterPatch("linked", "ALL", KB_DEFAULTS)).toEqual({ linked: undefined });
  });

  test("sets the key for a non-default value", () => {
    expect(singleFilterPatch("linked", "only", KB_DEFAULTS)).toEqual({ linked: "only" });
  });

  test("treats an undeclared filter's default as the empty string", () => {
    expect(singleFilterPatch("unknown", "", {})).toEqual({ unknown: undefined });
    expect(singleFilterPatch("unknown", "x", {})).toEqual({ unknown: "x" });
  });
});

describe("multiFilterPatch", () => {
  test("comma-encodes, trims and de-dupes values", () => {
    expect(multiFilterPatch("linkedTo", [" asset ", "application", "asset"], KB_DEFAULTS)).toEqual({
      linkedTo: "asset,application",
    });
  });

  test("clears the key for an empty list", () => {
    expect(multiFilterPatch("linkedTo", [], KB_DEFAULTS)).toEqual({ linkedTo: undefined });
  });

  test("clears the key when every value is blank", () => {
    expect(multiFilterPatch("linkedTo", ["", "  "], KB_DEFAULTS)).toEqual({ linkedTo: undefined });
  });
});

describe("buildFiltersPatch", () => {
  test("clears linked + linkedTo atomically (KB toggle off) and resets paging", () => {
    const patch = buildFiltersPatch({ linked: "ALL", linkedTo: [] }, KB_DEFAULTS);
    // Neither key survives — both are cleared in the SAME patch, the core #217 guarantee.
    expect(patch).toEqual({ linked: undefined, linkedTo: undefined, offset: undefined });
  });

  test("mixed single + multi keys, each encoded by its own rule", () => {
    const patch = buildFiltersPatch(
      { linked: "only", linkedTo: ["asset", "asset", "application"] },
      KB_DEFAULTS,
    );
    expect(patch).toEqual({
      linked: "only",
      linkedTo: "asset,application",
      offset: undefined,
    });
  });

  test("writes a from/to date pair together (informes)", () => {
    const patch = buildFiltersPatch(
      { from: "2026-01-01", to: "2026-02-01" },
      { from: "", to: "" },
    );
    expect(patch).toEqual({ from: "2026-01-01", to: "2026-02-01", offset: undefined });
  });

  test("end-to-end: KB toggle off from ?linked=only&linkedTo=asset yields no residual params", () => {
    // What the rewritten setLinkedOnly(false) feeds the hook, run through the full patch→URL path.
    const patch = buildFiltersPatch({ linked: "ALL", linkedTo: [] }, KB_DEFAULTS);
    const href = buildNextUrl("linked=only&linkedTo=asset", "/kb", patch);
    expect(href).toBe("/kb");
  });

  test("end-to-end: turning the toggle on sets linked=only and clears stale linkedTo", () => {
    const patch = buildFiltersPatch({ linked: "only", linkedTo: [] }, KB_DEFAULTS);
    const href = buildNextUrl("", "/kb", patch);
    expect(href).toBe("/kb?linked=only");
  });
});
