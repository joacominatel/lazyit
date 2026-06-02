import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  PageQuerySchema,
  PageMetaSchema,
  UnknownSortFieldError,
  offsetOf,
  pageOf,
  pageSchema,
  resolveSort,
  type PageQuery,
} from "./pagination";

/**
 * The ADR-0030 offset-pagination contract: a `{limit, offset}` / `{page, limit}` query that
 * normalizes to a canonical window, a `Page<T>` envelope, and the `offsetOf`/`pageOf` helpers.
 */

const parse = (input: unknown): PageQuery => PageQuerySchema.parse(input);

describe("PageQuerySchema — defaults & limit", () => {
  test("empty query → default limit, offset 0, deleted active", () => {
    expect(parse({})).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
      deleted: "active",
    });
  });

  test("coerces string limit/offset (the wire shape from @Query)", () => {
    expect(parse({ limit: "25", offset: "50" })).toEqual({
      limit: 25,
      offset: 50,
      deleted: "active",
    });
  });

  test("accepts the hard maximum limit", () => {
    expect(parse({ limit: MAX_PAGE_LIMIT }).limit).toBe(MAX_PAGE_LIMIT);
  });

  test("REJECTS a limit over the max (400, never silently clamped)", () => {
    const result = PageQuerySchema.safeParse({ limit: MAX_PAGE_LIMIT + 1 });
    expect(result.success).toBe(false);
  });

  test("rejects limit < 1", () => {
    expect(PageQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  test("rejects a negative offset", () => {
    expect(PageQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
  });

  test("rejects a non-integer limit", () => {
    expect(PageQuerySchema.safeParse({ limit: 10.5 }).success).toBe(false);
  });
});

describe("PageQuerySchema — page ↔ offset normalization", () => {
  test("page=1 → offset 0", () => {
    expect(parse({ page: 1, limit: 20 })).toEqual({
      limit: 20,
      offset: 0,
      deleted: "active",
    });
  });

  test("page=3 with limit=20 → offset 40", () => {
    expect(parse({ page: 3, limit: 20 })).toEqual({
      limit: 20,
      offset: 40,
      deleted: "active",
    });
  });

  test("page uses the default limit when limit is omitted", () => {
    expect(parse({ page: 2 })).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: DEFAULT_PAGE_LIMIT,
      deleted: "active",
    });
  });

  test("an explicit offset wins over page when both are given", () => {
    expect(parse({ page: 5, offset: 0, limit: 10 })).toEqual({
      limit: 10,
      offset: 0,
      deleted: "active",
    });
  });

  test("rejects page < 1", () => {
    expect(PageQuerySchema.safeParse({ page: 0 }).success).toBe(false);
  });
});

describe("PageQuerySchema — sort & dir (ADR-0030 amendment)", () => {
  test("no sort → no sort/dir on the normalized window", () => {
    expect(parse({ limit: 10 })).toEqual({
      limit: 10,
      offset: 0,
      deleted: "active",
    });
  });

  test("sort with no dir defaults dir to asc", () => {
    expect(parse({ sort: "name" })).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
      sort: "name",
      dir: "asc",
      deleted: "active",
    });
  });

  test("sort + explicit dir is carried through verbatim", () => {
    expect(parse({ sort: "createdAt", dir: "desc" })).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
      sort: "createdAt",
      dir: "desc",
      deleted: "active",
    });
  });

  test("dir without sort is dropped (no sort ⇒ no dir ⇒ service default order)", () => {
    expect(parse({ dir: "desc" })).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
      deleted: "active",
    });
  });

  test("rejects an invalid dir", () => {
    expect(
      PageQuerySchema.safeParse({ sort: "name", dir: "sideways" }).success,
    ).toBe(false);
  });

  test("rejects an empty sort string", () => {
    expect(PageQuerySchema.safeParse({ sort: "" }).success).toBe(false);
  });
});

describe("PageQuerySchema — deleted slice (ADR-0030 addendum / ADR-0041)", () => {
  test("omitted → defaults to active (live rows only)", () => {
    expect(parse({}).deleted).toBe("active");
  });

  test("deleted=active is carried through", () => {
    expect(parse({ deleted: "active" }).deleted).toBe("active");
  });

  test("deleted=only is carried through", () => {
    expect(parse({ deleted: "only" })).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 0,
      deleted: "only",
    });
  });

  test("rejects an unknown deleted value (e.g. all)", () => {
    expect(PageQuerySchema.safeParse({ deleted: "all" }).success).toBe(false);
  });
});

describe("resolveSort — per-resource allowlist", () => {
  const allow = { name: "name", updated: "updatedAt" };

  test("no sort on the query → undefined (use the service default order)", () => {
    expect(resolveSort({ sort: undefined, dir: undefined }, allow)).toBe(
      undefined,
    );
  });

  test("an allowed key maps to its Prisma field with the direction", () => {
    expect(resolveSort({ sort: "name", dir: "asc" }, allow)).toEqual({
      name: "asc",
    });
    expect(resolveSort({ sort: "updated", dir: "desc" }, allow)).toEqual({
      updatedAt: "desc",
    });
  });

  test("a wire key may differ from its Prisma column", () => {
    expect(resolveSort({ sort: "updated", dir: "asc" }, allow)).toEqual({
      updatedAt: "asc",
    });
  });

  test("defaults dir to asc when omitted", () => {
    expect(resolveSort({ sort: "name", dir: undefined }, allow)).toEqual({
      name: "asc",
    });
  });

  test("an unknown key throws UnknownSortFieldError listing the allowed fields", () => {
    expect(() => resolveSort({ sort: "secret", dir: "asc" }, allow)).toThrow(
      UnknownSortFieldError,
    );
    try {
      resolveSort({ sort: "secret", dir: "asc" }, allow);
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownSortFieldError);
      expect((err as UnknownSortFieldError).allowed).toEqual(["name", "updated"]);
    }
  });
});

describe("offsetOf", () => {
  test("maps the normalized window to Prisma take/skip", () => {
    expect(offsetOf({ limit: 25, offset: 50 })).toEqual({
      take: 25,
      skip: 50,
    });
  });
});

describe("pageOf", () => {
  test("builds the envelope, echoing limit/offset from the query", () => {
    const items = [{ id: "a" }, { id: "b" }];
    const page = pageOf(items, 7, { limit: 2, offset: 4 });
    expect(page).toEqual({ items, total: 7, limit: 2, offset: 4 });
  });

  test("an empty slice still carries the total and window", () => {
    expect(pageOf([], 0, { limit: 50, offset: 0 })).toEqual({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
    });
  });
});

describe("Page<T> envelope schema", () => {
  const ItemSchema = z.object({ id: z.string(), name: z.string() });
  const ItemPageSchema = pageSchema(ItemSchema);

  test("validates a well-formed page", () => {
    const value = {
      items: [{ id: "1", name: "one" }],
      total: 1,
      limit: 50,
      offset: 0,
    };
    expect(ItemPageSchema.safeParse(value).success).toBe(true);
  });

  test("rejects items that don't match the element schema", () => {
    const value = {
      items: [{ id: 1, name: "one" }],
      total: 1,
      limit: 50,
      offset: 0,
    };
    expect(ItemPageSchema.safeParse(value).success).toBe(false);
  });

  test("the metadata schema rejects a negative total", () => {
    expect(
      PageMetaSchema.safeParse({ total: -1, limit: 50, offset: 0 }).success,
    ).toBe(false);
  });
});
