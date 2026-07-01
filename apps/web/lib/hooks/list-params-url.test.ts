import { MAX_PAGE_LIMIT } from "@lazyit/shared";
import { describe, expect, test } from "bun:test";
import {
  buildFiltersPatch,
  buildNextUrl,
  deriveListState,
  multiFilterPatch,
  singleFilterPatch,
  toURLSearchParams,
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
    const href = buildNextUrl("", "/reports", { from: "2026-01-01", to: "2026-02-01" });
    const params = new URL(`http://x${href}`).searchParams;
    expect(params.get("from")).toBe("2026-01-01");
    expect(params.get("to")).toBe("2026-02-01");
  });

  test("preserves unrelated existing params", () => {
    const href = buildNextUrl("tab=assets&action=create", "/reports", {
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

  test("writes a from/to date pair together (reports)", () => {
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

/**
 * `deriveListState` is the pure read side shared by the client hook and Server Components (ADR-0067 /
 * #733). These pin the derivation rules a server-prefetch depends on — and the client/server PARITY
 * (same output whether the params come from a browser `URLSearchParams` or from a Server Component's
 * `searchParams` prop via `toURLSearchParams`), the thing that makes a prefetch key byte-identical to
 * the client's and so avoids a cache-miss double-fetch.
 */
const ASSET_OPTIONS = {
  filters: { status: "ALL", category: "ALL", archived: "ALL" },
  defaultSort: "updatedAt",
  defaultDir: "desc" as const,
};

describe("deriveListState", () => {
  test("no params → the first-paint defaults (query holds only limit/offset/page)", () => {
    const s = deriveListState(new URLSearchParams(""), ASSET_OPTIONS);
    expect(s.q).toBe("");
    expect(s.sort).toBe("updatedAt");
    expect(s.dir).toBe("desc");
    expect(s.limit).toBe(50);
    expect(s.offset).toBe(0);
    expect(s.page).toBe(1);
    expect(s.filtersActive).toBe(false);
    // Default-valued filters are omitted from the backend-shaped query; the default sort is always
    // present (there's a `defaultSort`), so the first-paint query carries paging + sort/dir only.
    expect(s.query).toEqual({
      limit: 50,
      offset: 0,
      page: 1,
      sort: "updatedAt",
      dir: "desc",
    });
    expect(s.filters).toEqual({ status: "ALL", category: "ALL", archived: "ALL" });
  });

  test("no sort default → sort undefined, dir falls back to defaultDir, no sort in query", () => {
    const s = deriveListState(new URLSearchParams(""), {});
    expect(s.sort).toBeUndefined();
    expect(s.dir).toBe("desc");
    expect(s.query.sort).toBeUndefined();
    expect(s.query.dir).toBeUndefined();
  });

  test("a filtered/paged/searched URL → active filters + query carries only non-defaults", () => {
    const s = deriveListState(
      new URLSearchParams("q=dell&status=ACTIVE&sort=name&dir=asc&offset=50"),
      ASSET_OPTIONS,
    );
    expect(s.q).toBe("dell");
    expect(s.sort).toBe("name");
    expect(s.dir).toBe("asc");
    expect(s.offset).toBe(50);
    expect(s.page).toBe(2); // floor(50/50)+1
    expect(s.filters.status).toBe("ACTIVE");
    expect(s.filters.category).toBe("ALL"); // untouched → still its default
    expect(s.filtersActive).toBe(true);
    // Only q + sort/dir + the non-default `status` land in the query; `category`/`archived` stay out.
    expect(s.query).toEqual({
      limit: 50,
      offset: 50,
      page: 2,
      q: "dell",
      sort: "name",
      dir: "asc",
      status: "ACTIVE",
    });
  });

  test("clamps a tampered ?limit over the API cap to MAX_PAGE_LIMIT (issue #508)", () => {
    const s = deriveListState(new URLSearchParams(`limit=${MAX_PAGE_LIMIT + 5000}`), {});
    expect(s.limit).toBe(MAX_PAGE_LIMIT);
  });

  test("garbage limit/offset fall back to the defaults (no NaN leaks into the query)", () => {
    const s = deriveListState(new URLSearchParams("limit=abc&offset=-4"), {});
    expect(s.limit).toBe(50);
    expect(s.offset).toBe(0);
    expect(s.page).toBe(1);
  });

  test("client/server PARITY: URLSearchParams and a Server Component searchParams prop agree", () => {
    // The exact match the filtered-prefetch relies on: the browser hook reads a `URLSearchParams`
    // (from `useSearchParams()`); the server page reads the same URL via its `searchParams` prop,
    // normalized with `toURLSearchParams`. Both must derive the identical query object.
    const fromBrowser = deriveListState(
      new URLSearchParams("q=dell&status=ACTIVE&offset=50"),
      ASSET_OPTIONS,
    );
    const fromServer = deriveListState(
      toURLSearchParams({ q: "dell", status: "ACTIVE", offset: "50" }),
      ASSET_OPTIONS,
    );
    expect(fromServer.query).toEqual(fromBrowser.query);
  });
});

describe("toURLSearchParams", () => {
  test("skips undefined keys and collapses a repeated param to its first value", () => {
    const usp = toURLSearchParams({ q: "vpn", status: undefined, tag: ["a", "b"] });
    expect(usp.get("q")).toBe("vpn");
    expect(usp.has("status")).toBe(false);
    expect(usp.get("tag")).toBe("a");
  });
});
