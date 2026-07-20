import { describe, expect, test } from "bun:test";
import type { Folder } from "@lazyit/shared";
import { articleFolderTrail, articleSiblings } from "./kb-reading";

/**
 * Unit coverage for the two pure derivations behind the KB reading view (#1106 Phase 2): the full
 * folder-path breadcrumb trail and the prev/next sibling footer. Both are projections over
 * already-loaded data (no DOM, no endpoint), so they are tested directly. Cycle + missing-parent
 * guards are asserted so malformed data can never hang the reading page.
 */

/** Minimal Folder factory — only the structural fields the trail walk reads. */
function folder(id: string, parentId: string | null = null): Folder {
  return {
    id,
    name: id,
    description: null,
    icon: null,
    order: null,
    parentId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  };
}

// runbooks → networking → vpn ; plus an unrelated root.
const FOLDERS: Folder[] = [
  folder("runbooks"),
  folder("networking", "runbooks"),
  folder("vpn", "networking"),
  folder("other"),
];

describe("articleFolderTrail", () => {
  test("returns the root→home chain in order", () => {
    expect(articleFolderTrail("vpn", FOLDERS).map((f) => f.id)).toEqual([
      "runbooks",
      "networking",
      "vpn",
    ]);
  });

  test("a root home folder is a single-element trail", () => {
    expect(articleFolderTrail("runbooks", FOLDERS).map((f) => f.id)).toEqual([
      "runbooks",
    ]);
  });

  test("an unknown/soft-deleted home folder yields an empty trail (no broken crumb)", () => {
    expect(articleFolderTrail("ghost", FOLDERS)).toEqual([]);
    expect(articleFolderTrail(null, FOLDERS)).toEqual([]);
  });

  test("a missing ancestor stops the walk without dropping the known leaf", () => {
    // `networking`'s parent (`runbooks`) is absent from the live set → surface `networking` as the root.
    const partial: Folder[] = [
      folder("networking", "runbooks"),
      folder("vpn", "networking"),
    ];
    expect(articleFolderTrail("vpn", partial).map((f) => f.id)).toEqual([
      "networking",
      "vpn",
    ]);
  });

  test("a parentId cycle terminates (bounded by the visited set)", () => {
    const cyclic: Folder[] = [folder("a", "b"), folder("b", "a")];
    const trail = articleFolderTrail("a", cyclic).map((f) => f.id);
    // Both nodes appear once; the walk halts instead of looping forever.
    expect(new Set(trail)).toEqual(new Set(["a", "b"]));
  });
});

describe("articleSiblings", () => {
  const ARTICLES = [
    { id: "1", slug: "firewall-rules", title: "Firewall rules" },
    { id: "2", slug: "dns-records", title: "DNS records" },
    { id: "3", slug: "vpn-setup", title: "VPN setup" },
  ];

  test("orders by title (locale-aware) and returns both neighbours", () => {
    // Sorted by title: DNS records, Firewall rules, VPN setup.
    expect(articleSiblings(ARTICLES, "1")).toEqual({
      prev: { slug: "dns-records", title: "DNS records" },
      next: { slug: "vpn-setup", title: "VPN setup" },
    });
  });

  test("the first sibling has no prev; the last has no next", () => {
    expect(articleSiblings(ARTICLES, "2").prev).toBeNull();
    expect(articleSiblings(ARTICLES, "3").next).toBeNull();
  });

  test("a lone article in its folder has no neighbours", () => {
    expect(articleSiblings([ARTICLES[0]!], "1")).toEqual({
      prev: null,
      next: null,
    });
  });

  test("an article absent from the set yields no neighbours", () => {
    expect(articleSiblings(ARTICLES, "missing")).toEqual({
      prev: null,
      next: null,
    });
  });
});
