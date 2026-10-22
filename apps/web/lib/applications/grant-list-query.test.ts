import { describe, expect, test } from "bun:test";
import { applicationGrantPageFilterParams } from "@/lib/api/endpoints/applications";
import { buildNextUrl, deriveListState } from "@/lib/hooks/list-params-url";
import {
  ANY_ACCESS_LEVEL,
  clearGrantFiltersPatch,
  deriveGrantPageParams,
  GRANT_LIST_OPTIONS,
  GRANT_PAGE_SIZE,
  grantLevelPatch,
  grantLevelSelection,
  grantOffsetPatch,
  grantSearchPatch,
  grantStatusPatch,
  isGrantListNarrowed,
  NO_ACCESS_LEVEL,
} from "./grant-list-query";

const PATH = "/applications/app-1";

function paramsFor(search: string, canSearchPeople = true) {
  return deriveGrantPageParams(deriveListState(new URLSearchParams(search), GRANT_LIST_OPTIONS), {
    canSearchPeople,
  });
}

/** Apply a patch the way the tab does, and read the request back. */
function after(search: string, patch: Parameters<typeof buildNextUrl>[2]) {
  const next = buildNextUrl(search, PATH, patch);
  return next.includes("?") ? next.slice(next.indexOf("?") + 1) : "";
}

describe("deriveGrantPageParams", () => {
  test("a bare URL asks for the first page of active grants", () => {
    expect(paramsFor("")).toEqual({ status: "active", limit: GRANT_PAGE_SIZE, offset: 0 });
    expect(paramsFor("tab=access")).toEqual({ status: "active", limit: GRANT_PAGE_SIZE, offset: 0 });
  });

  test("reads status, level, search and offset", () => {
    expect(paramsFor("status=expiring&level=admin&q=ana&offset=25")).toEqual({
      status: "expiring",
      accessLevel: "admin",
      q: "ana",
      limit: GRANT_PAGE_SIZE,
      offset: 25,
    });
  });

  test("an unknown status from a stale link falls back to active instead of a 400", () => {
    expect(paramsFor("status=bogus").status).toBe("active");
  });

  test("noLevel wins over a level, so the request never sends both (the API 400s)", () => {
    const params = paramsFor("level=admin&noLevel=true");
    expect(params.noAccessLevel).toBe(true);
    expect(params.accessLevel).toBeUndefined();
    expect(paramsFor("noLevel=yes").noAccessLevel).toBeUndefined();
  });

  test("a blank or over-long level is dropped rather than sent", () => {
    expect(paramsFor("level=%20%20").accessLevel).toBeUndefined();
    expect(paramsFor(`level=${"x".repeat(101)}`).accessLevel).toBeUndefined();
    expect(paramsFor(`level=${"x".repeat(100)}`).accessLevel).toHaveLength(100);
  });

  test("the person search is sent only to a viewer who may read people", () => {
    expect(paramsFor("q=ana").q).toBe("ana");
    expect(paramsFor("q=ana", false).q).toBeUndefined();
    expect(paramsFor("q=%20%20").q).toBeUndefined();
  });

  test("an over-long search is cut to the API's 200 characters", () => {
    expect(paramsFor(`q=${"a".repeat(250)}`).q).toHaveLength(200);
  });

  test("a hand-edited limit is clamped to the API maximum", () => {
    expect(paramsFor("limit=5000").limit).toBe(200);
  });
});

describe("the export sends the list's filters", () => {
  test("every filter, never paging, status always present", () => {
    const params = paramsFor("status=revoked&level=admin&q=ana&offset=50");
    expect([...applicationGrantPageFilterParams(params).entries()]).toEqual([
      ["status", "revoked"],
      ["accessLevel", "admin"],
      ["q", "ana"],
    ]);
  });

  test("the default view still names its status, so the export does not fall back to the legacy filters", () => {
    expect(applicationGrantPageFilterParams(paramsFor("")).toString()).toBe("status=active");
  });

  test("no level and no search for a viewer without user:read", () => {
    expect(applicationGrantPageFilterParams(paramsFor("noLevel=true&q=ana", false)).toString()).toBe(
      "status=active&noAccessLevel=true",
    );
  });
});

describe("patches", () => {
  test("changing the status keeps the tab and the filters, drops the default, and resets paging", () => {
    expect(after("tab=access&q=ana&offset=50", grantStatusPatch("expiring"))).toBe(
      "tab=access&q=ana&status=expiring",
    );
    expect(after("status=revoked&offset=25", grantStatusPatch("active"))).toBe("");
  });

  test("picking a level writes level and noLevel together", () => {
    const noLevel = after("level=admin&offset=25", grantLevelPatch(NO_ACCESS_LEVEL));
    expect(noLevel).toBe("noLevel=true");
    expect(paramsFor(noLevel).noAccessLevel).toBe(true);

    const admin = after(noLevel, grantLevelPatch("admin"));
    expect(admin).toBe("level=admin");
    expect(after(admin, grantLevelPatch(ANY_ACCESS_LEVEL))).toBe("");
  });

  test("searching trims and resets paging; an empty search clears the key", () => {
    expect(after("offset=25", grantSearchPatch("  ana "))).toBe("q=ana");
    expect(after("q=ana", grantSearchPatch("   "))).toBe("");
  });

  test("clearing the filters keeps the status view", () => {
    expect(after("status=revoked&q=ana&level=admin&offset=25", clearGrantFiltersPatch())).toBe(
      "status=revoked",
    );
  });

  test("paging writes the offset, and the first page drops it", () => {
    expect(after("status=revoked", grantOffsetPatch(25))).toBe("status=revoked&offset=25");
    expect(after("offset=25", grantOffsetPatch(0))).toBe("");
  });
});

describe("selection and narrowing", () => {
  test("the picker value follows the request", () => {
    expect(grantLevelSelection(paramsFor(""))).toBe(ANY_ACCESS_LEVEL);
    expect(grantLevelSelection(paramsFor("level=admin"))).toBe("admin");
    expect(grantLevelSelection(paramsFor("noLevel=true"))).toBe(NO_ACCESS_LEVEL);
  });

  test("a search or a level narrows the view; the status alone does not", () => {
    expect(isGrantListNarrowed(paramsFor("status=revoked"))).toBe(false);
    expect(isGrantListNarrowed(paramsFor("q=ana"))).toBe(true);
    expect(isGrantListNarrowed(paramsFor("q=ana", false))).toBe(false);
    expect(isGrantListNarrowed(paramsFor("noLevel=true"))).toBe(true);
  });
});
