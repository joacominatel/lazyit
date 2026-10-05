import { describe, expect, test } from "bun:test";
import { deriveListState } from "@/lib/hooks/list-params-url";
import {
  ASSET_LIST_OPTIONS,
  deriveAssetFilters,
  statusFilterChoice,
  statusFilterPatch,
  statusLabelFilterId,
} from "./assets-list-query";

const LABEL = "clloaner0001";

function filtersFor(search: string) {
  const state = deriveListState(new URLSearchParams(search), ASSET_LIST_OPTIONS);
  return deriveAssetFilters(state, { isAdmin: false });
}

describe("the custom status filter (ADR-0101)", () => {
  test("?statusLabel=<id> maps to statusLabelId; no param leaves the key unset", () => {
    expect(filtersFor(`statusLabel=${LABEL}`).statusLabelId).toBe(LABEL);
    expect(filtersFor("").statusLabelId).toBeUndefined();
    expect(filtersFor("status=IN_STORAGE").statusLabelId).toBeUndefined();
  });

  test("a garbage id is dropped instead of reaching the API (which would 400)", () => {
    expect(statusLabelFilterId("not a cuid")).toBeUndefined();
    expect(statusLabelFilterId("ALL")).toBeUndefined();
    expect(statusLabelFilterId(undefined)).toBeUndefined();
    expect(filtersFor("statusLabel=x").statusLabelId).toBeUndefined();
  });

  test("picking a custom status clears the built-in one, and the reverse", () => {
    expect(statusFilterPatch({ status: "IN_STORAGE", labelId: LABEL })).toEqual({
      status: "ALL",
      statusLabel: LABEL,
    });
    expect(statusFilterPatch({ status: "RETIRED", labelId: null })).toEqual({
      status: "RETIRED",
      statusLabel: "ALL",
    });
    expect(statusFilterPatch(null)).toEqual({ status: "ALL", statusLabel: "ALL" });
  });

  test("the picker's choice: a known custom status, else the built-in status, else none", () => {
    const kindOf = (id: string) => (id === LABEL ? ("IN_STORAGE" as const) : undefined);
    expect(statusFilterChoice({ status: "ALL", statusLabel: LABEL }, kindOf)).toEqual({
      status: "IN_STORAGE",
      labelId: LABEL,
    });
    expect(statusFilterChoice({ status: "LOST", statusLabel: "ALL" }, kindOf)).toEqual({
      status: "LOST",
      labelId: null,
    });
    // An unknown (not yet loaded, or archived) custom status falls back to the built-in filter.
    expect(statusFilterChoice({ status: "ALL", statusLabel: "clunknown0001" }, kindOf)).toBeNull();
    expect(statusFilterChoice({ status: "ALL", statusLabel: "ALL" }, kindOf)).toBeNull();
  });
});
