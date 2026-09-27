import { describe, expect, test } from "bun:test";
import type { Folder } from "@lazyit/shared";
import {
  ancestorFolderIds,
  buildFolderTree,
  descendantFolderCount,
  folderPathOptions,
  restrictedAncestorOf,
} from "./folder-tree";

/**
 * Unit coverage for the pure folder-tree helpers backing the KB browser. `restrictedAncestorOf`
 * drives the inherited-restriction padlock/headline (#414) and `descendantFolderCount` drives the
 * cascade-delete pre-count (#415) — both are presentation logic over the flat folder list, so they
 * are tested directly (no DOM). Cycle guards are asserted so malformed data can never hang the UI.
 */

/** Minimal Folder factory — only the structural fields these helpers read. */
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

// lazyit (restricted) → docs → 00-overview, 01-architecture ; plus an unrelated root.
const FOLDERS: Folder[] = [
  folder("lazyit"),
  folder("docs", "lazyit"),
  folder("overview", "docs"),
  folder("arch", "docs"),
  folder("other"),
];

const parentById = new Map(FOLDERS.map((f) => [f.id, f.parentId]));

describe("restrictedAncestorOf", () => {
  const restricted = new Set(["lazyit"]);

  test("a descendant inherits the nearest restricted ancestor's id", () => {
    expect(restrictedAncestorOf("docs", parentById, restricted)).toBe("lazyit");
    expect(restrictedAncestorOf("overview", parentById, restricted)).toBe(
      "lazyit",
    );
    expect(restrictedAncestorOf("arch", parentById, restricted)).toBe("lazyit");
  });

  test("returns null when no ancestor is restricted", () => {
    expect(restrictedAncestorOf("lazyit", parentById, restricted)).toBeNull();
    expect(restrictedAncestorOf("other", parentById, restricted)).toBeNull();
  });

  test("returns the NEAREST restricted ancestor when several are restricted", () => {
    const both = new Set(["lazyit", "docs"]);
    expect(restrictedAncestorOf("overview", parentById, both)).toBe("docs");
  });

  test("terminates on a malformed cycle", () => {
    const cyclic = new Map<string, string | null>([
      ["a", "b"],
      ["b", "a"],
    ]);
    expect(restrictedAncestorOf("a", cyclic, new Set())).toBeNull();
  });
});

describe("descendantFolderCount", () => {
  test("counts all transitive sub-folders, excluding the folder itself", () => {
    expect(descendantFolderCount(FOLDERS, "lazyit")).toBe(3); // docs, overview, arch
    expect(descendantFolderCount(FOLDERS, "docs")).toBe(2); // overview, arch
  });

  test("a leaf folder has zero descendants", () => {
    expect(descendantFolderCount(FOLDERS, "overview")).toBe(0);
    expect(descendantFolderCount(FOLDERS, "other")).toBe(0);
  });

  test("terminates on a malformed cycle", () => {
    const cyclic = [folder("a", "b"), folder("b", "a")];
    expect(descendantFolderCount(cyclic, "a")).toBeLessThanOrEqual(2);
  });
});

describe("tree/ancestor helpers still hold", () => {
  test("buildFolderTree nests children under their parent", () => {
    const tree = buildFolderTree(FOLDERS);
    const roots = tree.map((n) => n.folder.id).sort();
    expect(roots).toEqual(["lazyit", "other"]);
    const lazyit = tree.find((n) => n.folder.id === "lazyit");
    expect(lazyit?.children.map((c) => c.folder.id)).toEqual(["docs"]);
  });

  test("ancestorFolderIds walks the parent chain", () => {
    expect([...ancestorFolderIds(FOLDERS, "overview")].sort()).toEqual([
      "docs",
      "lazyit",
    ]);
  });
});

describe("folderPathOptions", () => {
  test("labels every folder by its full path so repeated leaf names stay unambiguous", () => {
    const repeated: Folder[] = [
      folder("Servers"),
      folder("Workstations"),
      { ...folder("linux-a", "Servers"), name: "Linux" },
      { ...folder("linux-b", "Workstations"), name: "Linux" },
    ];
    expect(folderPathOptions(repeated)).toEqual([
      { id: "Servers", label: "Servers" },
      { id: "linux-a", label: "Servers / Linux" },
      { id: "Workstations", label: "Workstations" },
      { id: "linux-b", label: "Workstations / Linux" },
    ]);
  });

  test("orders by the full path label, case-insensitively", () => {
    const labels = folderPathOptions(FOLDERS).map((o) => o.label);
    expect(labels).toEqual([
      "lazyit",
      "lazyit / docs",
      "lazyit / docs / arch",
      "lazyit / docs / overview",
      "other",
    ]);
  });

  test("returns every folder — descendants included, for the caller to narrow", () => {
    // The move picker drops only the folder being moved; its descendants stay offerable so an
    // attempted cycle reaches the server's guard instead of a second, drifting client-side copy.
    const ids = folderPathOptions(FOLDERS).map((o) => o.id);
    expect(ids.sort()).toEqual(FOLDERS.map((f) => f.id).sort());
  });
});
