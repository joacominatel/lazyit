import { describe, expect, test } from "bun:test";
import {
  addRecent,
  clearRecent,
  parseRecent,
  RECENT_LIMIT,
  type RecentArticle,
  type RecentStorage,
  readRecent,
  recentStorageKey,
  recordRecent,
} from "./kb-recent";

function memoryStorage(): RecentStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const throwingStorage: RecentStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

const entry = (slug: string, openedAt: string, extra: Partial<RecentArticle> = {}): RecentArticle => ({
  slug,
  title: slug.toUpperCase(),
  categoryId: "c1",
  openedAt,
  ...extra,
});

describe("parseRecent", () => {
  test("empty, invalid JSON and non-arrays yield an empty list", () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent("")).toEqual([]);
    expect(parseRecent("{not json")).toEqual([]);
    expect(parseRecent('{"slug":"a"}')).toEqual([]);
  });

  test("drops malformed entries and strips unknown keys", () => {
    const raw = JSON.stringify([
      { ...entry("ok", "2026-10-01T10:00:00.000Z"), extra: "x" },
      { slug: "", title: "t", categoryId: null, openedAt: "2026-10-01T10:00:00.000Z" },
      { slug: "no-date", title: "t", categoryId: null, openedAt: "yesterday" },
      { slug: "bad-folder", title: "t", categoryId: 4, openedAt: "2026-10-01T10:00:00.000Z" },
      "string",
    ]);
    expect(parseRecent(raw)).toEqual([entry("ok", "2026-10-01T10:00:00.000Z")]);
  });

  test("sorts newest first, keeps the newest duplicate and caps the list", () => {
    const many = Array.from({ length: RECENT_LIMIT + 5 }, (_, i) =>
      entry(`a${i}`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()),
    );
    many.push(entry("a0", "2027-01-01T00:00:00.000Z", { title: "Newest" }));
    const parsed = parseRecent(JSON.stringify(many));
    expect(parsed).toHaveLength(RECENT_LIMIT);
    expect(parsed[0]).toEqual(entry("a0", "2027-01-01T00:00:00.000Z", { title: "Newest" }));
    expect(parsed.filter((item) => item.slug === "a0")).toHaveLength(1);
  });
});

describe("addRecent", () => {
  test("puts the opened article first and de-duplicates by slug", () => {
    const list = [entry("b", "2026-10-02T00:00:00.000Z"), entry("a", "2026-10-01T00:00:00.000Z")];
    const next = addRecent(list, { slug: "a", title: "A2", categoryId: null }, new Date("2026-10-03T00:00:00.000Z"));
    expect(next.map((item) => item.slug)).toEqual(["a", "b"]);
    expect(next[0]).toEqual({ slug: "a", title: "A2", categoryId: null, openedAt: "2026-10-03T00:00:00.000Z" });
  });

  test("never grows past the limit", () => {
    const full = Array.from({ length: RECENT_LIMIT }, (_, i) => entry(`a${i}`, "2026-10-01T00:00:00.000Z"));
    const next = addRecent(full, { slug: "new", title: "New", categoryId: "c1" }, new Date());
    expect(next).toHaveLength(RECENT_LIMIT);
    expect(next[0].slug).toBe("new");
    expect(next.some((item) => item.slug === `a${RECENT_LIMIT - 1}`)).toBe(false);
  });
});

describe("storage", () => {
  test("keys are scoped per user", () => {
    expect(recentStorageKey("u1")).not.toBe(recentStorageKey("u2"));
  });

  test("record then read round-trips", () => {
    const storage = memoryStorage();
    const key = recentStorageKey("u1");
    recordRecent(key, { slug: "vpn", title: "VPN", categoryId: "c1" }, storage, new Date("2026-10-01T00:00:00.000Z"));
    recordRecent(key, { slug: "dns", title: "DNS", categoryId: null }, storage, new Date("2026-10-02T00:00:00.000Z"));
    expect(readRecent(key, storage).map((item) => item.slug)).toEqual(["dns", "vpn"]);
    expect(readRecent(recentStorageKey("u2"), storage)).toEqual([]);
    clearRecent(key, storage);
    expect(readRecent(key, storage)).toEqual([]);
  });

  test("an unavailable or throwing storage never throws", () => {
    const key = recentStorageKey("u1");
    expect(readRecent(key, null)).toEqual([]);
    expect(readRecent(key, throwingStorage)).toEqual([]);
    expect(() => recordRecent(key, { slug: "a", title: "A", categoryId: null }, throwingStorage)).not.toThrow();
    expect(() => clearRecent(key, throwingStorage)).not.toThrow();
  });
});
