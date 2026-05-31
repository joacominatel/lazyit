import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  offsetOf,
  pageOf,
  PageQuerySchema,
  pageSchema,
} from "./pagination";

/**
 * The offset/limit pagination contract (ADR-0030). Covers the query-param coercion + bounds, the
 * `{ page, limit }` → offset conversion, the default/hard-max policy, and the `pageOf` envelope.
 */

describe("PageQuerySchema", () => {
  test("empty query → default limit, no offset/page", () => {
    const parsed = PageQuerySchema.parse({});
    expect(parsed.limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(parsed.offset).toBeUndefined();
    expect(parsed.page).toBeUndefined();
  });

  test("coerces string query params (limit/offset/page arrive as strings)", () => {
    const parsed = PageQuerySchema.parse({ limit: "25", offset: "100", page: "2" });
    expect(parsed.limit).toBe(25);
    expect(parsed.offset).toBe(100);
    expect(parsed.page).toBe(2);
  });

  test("accepts the hard maximum limit", () => {
    expect(PageQuerySchema.parse({ limit: String(MAX_PAGE_LIMIT) }).limit).toBe(MAX_PAGE_LIMIT);
  });

  test("rejects a limit over the hard maximum (not clamped)", () => {
    expect(PageQuerySchema.safeParse({ limit: MAX_PAGE_LIMIT + 1 }).success).toBe(false);
  });

  test("rejects limit 0 and a negative offset", () => {
    expect(PageQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(PageQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
    expect(PageQuerySchema.safeParse({ page: 0 }).success).toBe(false);
  });
});

describe("offsetOf", () => {
  test("offset is authoritative when present", () => {
    expect(offsetOf({ limit: 50, offset: 30, page: 5 })).toEqual({ take: 50, skip: 30 });
  });

  test("derives skip from a 1-based page when offset is absent", () => {
    expect(offsetOf({ limit: 20, offset: undefined, page: 3 })).toEqual({ take: 20, skip: 40 });
    expect(offsetOf({ limit: 20, offset: undefined, page: 1 })).toEqual({ take: 20, skip: 0 });
  });

  test("defaults skip to 0 when neither offset nor page is given", () => {
    expect(offsetOf({ limit: 50, offset: undefined, page: undefined })).toEqual({
      take: 50,
      skip: 0,
    });
  });
});

describe("pageOf", () => {
  test("echoes the effective limit/offset and carries items + total", () => {
    const page = pageOf([{ id: "a" }, { id: "b" }], 7, { limit: 2, offset: 4, page: undefined });
    expect(page).toEqual({
      items: [{ id: "a" }, { id: "b" }],
      total: 7,
      limit: 2,
      offset: 4,
    });
  });

  test("reports offset 0 when the query used a defaulted page", () => {
    const page = pageOf([], 0, PageQuerySchema.parse({}));
    expect(page).toEqual({ items: [], total: 0, limit: DEFAULT_PAGE_LIMIT, offset: 0 });
  });
});

describe("pageSchema", () => {
  test("validates a well-formed envelope of the given item", () => {
    const schema = pageSchema(z.object({ id: z.string() }));
    const ok = schema.safeParse({
      items: [{ id: "x" }],
      total: 1,
      limit: 50,
      offset: 0,
    });
    expect(ok.success).toBe(true);
  });

  test("rejects an envelope missing total", () => {
    const schema = pageSchema(z.object({ id: z.string() }));
    expect(schema.safeParse({ items: [], limit: 50, offset: 0 }).success).toBe(false);
  });
});
