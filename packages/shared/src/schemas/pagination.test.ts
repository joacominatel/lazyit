import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  PageQuerySchema,
  PageMetaSchema,
  offsetOf,
  pageOf,
  pageSchema,
  type PageQuery,
} from "./pagination";

/**
 * The ADR-0030 offset-pagination contract: a `{limit, offset}` / `{page, limit}` query that
 * normalizes to a canonical window, a `Page<T>` envelope, and the `offsetOf`/`pageOf` helpers.
 */

const parse = (input: unknown): PageQuery => PageQuerySchema.parse(input);

describe("PageQuerySchema — defaults & limit", () => {
  test("empty query → default limit, offset 0", () => {
    expect(parse({})).toEqual({ limit: DEFAULT_PAGE_LIMIT, offset: 0 });
  });

  test("coerces string limit/offset (the wire shape from @Query)", () => {
    expect(parse({ limit: "25", offset: "50" })).toEqual({
      limit: 25,
      offset: 50,
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
    expect(parse({ page: 1, limit: 20 })).toEqual({ limit: 20, offset: 0 });
  });

  test("page=3 with limit=20 → offset 40", () => {
    expect(parse({ page: 3, limit: 20 })).toEqual({ limit: 20, offset: 40 });
  });

  test("page uses the default limit when limit is omitted", () => {
    expect(parse({ page: 2 })).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: DEFAULT_PAGE_LIMIT,
    });
  });

  test("an explicit offset wins over page when both are given", () => {
    expect(parse({ page: 5, offset: 0, limit: 10 })).toEqual({
      limit: 10,
      offset: 0,
    });
  });

  test("rejects page < 1", () => {
    expect(PageQuerySchema.safeParse({ page: 0 }).success).toBe(false);
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
