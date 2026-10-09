import { describe, expect, test } from "bun:test";
import { branchArticleCount, rankFolderCards } from "./kb-folder-rank";

const f = (id: string, articleCount?: number | null) => ({ id, articleCount });

describe("branchArticleCount", () => {
  test("sums the folder and every descendant", () => {
    const root = f("root", 1);
    const child = f("child", 2);
    const grandchild = f("grandchild", 3);
    const children = new Map([
      ["root", [child]],
      ["child", [grandchild]],
    ]);
    expect(branchArticleCount(root, children)).toBe(6);
  });

  test("treats a withheld or absent count as zero", () => {
    const root = f("root", null);
    const children = new Map([["root", [f("a"), f("b", 4)]]]);
    expect(branchArticleCount(root, children)).toBe(4);
  });

  test("walks a cycle once", () => {
    const a = f("a", 1);
    const b = f("b", 2);
    const children = new Map([
      ["a", [b]],
      ["b", [a]],
    ]);
    expect(branchArticleCount(a, children)).toBe(3);
  });
});

describe("rankFolderCards", () => {
  test("puts the fullest branch first, counting descendants", () => {
    const empty = f("empty", 0);
    const shallow = f("shallow", 5);
    const deep = f("deep", 1);
    const children = new Map([["deep", [f("deep-child", 10)]]]);
    expect(rankFolderCards([empty, shallow, deep], children).map((x) => x.id)).toEqual([
      "deep",
      "shallow",
      "empty",
    ]);
  });

  test("keeps the tree order between equal folders", () => {
    const roots = [f("first", 0), f("second", 0), f("third", 0)];
    expect(rankFolderCards(roots, new Map()).map((x) => x.id)).toEqual(["first", "second", "third"]);
  });

  test("does not mutate its input", () => {
    const roots = [f("a", 0), f("b", 3)];
    rankFolderCards(roots, new Map());
    expect(roots.map((x) => x.id)).toEqual(["a", "b"]);
  });
});
