import type { Folder } from "@lazyit/shared";

/**
 * Build a nested folder tree from the flat `Folder` list (ADR-0059 §1). A `Folder` IS an
 * `ArticleCategory` carrying a self-ref `parentId` (`null` = a root folder); the flat set is the root
 * level of a tree. Pure and framework-agnostic — the KB browser turns this into a collapsible nav.
 *
 * The API returns folders flat; this is the client-side projection into the parent→children shape the
 * tree renders. A folder whose `parentId` points at a missing/soft-deleted parent (it never appears in
 * the live list) is treated as a ROOT so it is never silently dropped from the browser.
 */

/** A folder enriched with its children — one node of the rendered tree. */
export interface FolderNode {
  folder: Folder;
  children: FolderNode[];
}

/**
 * Project a flat folder list into a `FolderNode[]` forest (root folders, each with nested children).
 * Siblings are ordered by `order` (ascending; nulls last) then `name` (locale-aware, case-insensitive)
 * so the browser is deterministic and matches the sidebar/listing sort intent of the `order` column.
 * An orphaned `parentId` (parent not in the live set) is promoted to a root rather than dropped.
 */
export function buildFolderTree(folders: Folder[]): FolderNode[] {
  const nodeById = new Map<string, FolderNode>();
  for (const folder of folders) {
    nodeById.set(folder.id, { folder, children: [] });
  }

  const roots: FolderNode[] = [];
  for (const node of nodeById.values()) {
    const parentId = node.folder.parentId;
    const parent = parentId ? nodeById.get(parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      // Root folder (parentId null) OR an orphan whose parent is gone — surface it at the root.
      roots.push(node);
    }
  }

  sortNodes(roots);
  return roots;
}

/** Recursively sort a node list and its descendants by (order asc, nulls last) then name. */
function sortNodes(nodes: FolderNode[]): void {
  nodes.sort((a, b) => compareFolderOrder(a.folder, b.folder));
  for (const node of nodes) sortNodes(node.children);
}

/**
 * Comparator over two `Folder`s: `order` ascending (nulls last) then `name` (case-insensitive,
 * locale-aware) — the listing/sidebar sort intent (ADR-0059 §1). Exported so the KB content-area
 * child-folder cards (#413) order sub-folders identically to the tree, from one definition.
 */
export function compareFolderOrder(a: Folder, b: Folder): number {
  const ao = a.order;
  const bo = b.order;
  if (ao !== bo) {
    if (ao === null) return 1;
    if (bo === null) return -1;
    return ao - bo;
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/**
 * Build the full breadcrumb path label of a folder ("Servers / Linux / Provisioning"), walking up
 * the `parentId` chain via the supplied `folderById` map. So a nested folder whose leaf name repeats
 * across the tree (`Servers/Linux` vs `Workstations/Linux`) stays unambiguous in a flat list (the
 * alias picker, the home-folder badge). Guards against a malformed cycle with a depth cap so it always
 * terminates. Falls back to the bare folder name when an ancestor is missing from the map.
 */
export function folderPathLabel(
  folder: Folder,
  folderById: Map<string, Folder>,
): string {
  const parts: string[] = [folder.name];
  const seen = new Set<string>([folder.id]);
  let parentId = folder.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = folderById.get(parentId);
    if (!parent) break;
    parts.unshift(parent.name);
    parentId = parent.parentId;
  }
  return parts.join(" / ");
}

/**
 * Collect the id of every ancestor folder of `folderId` (its parent, grandparent, …), so the browser
 * can auto-expand the path down to a selected folder. Returns an empty set for a root or unknown id.
 * Guards against a malformed cycle (a folder transitively its own ancestor) with a visited set, so it
 * always terminates even on bad data.
 */
export function ancestorFolderIds(
  folders: Folder[],
  folderId: string | null | undefined,
): Set<string> {
  const ancestors = new Set<string>();
  if (!folderId) return ancestors;
  const parentById = new Map(folders.map((f) => [f.id, f.parentId]));
  let current = parentById.get(folderId) ?? null;
  while (current && !ancestors.has(current)) {
    ancestors.add(current);
    current = parentById.get(current) ?? null;
  }
  return ancestors;
}

/**
 * Count how many folders are descendants of `folderId` (its sub-folders, transitively) in the flat
 * `folders` list — for the cascade-delete warning's "and N sub-folders" pre-count (#415). Pure; a
 * malformed cycle is bounded by a visited set so it always terminates. Excludes the folder itself.
 */
export function descendantFolderCount(
  folders: Folder[],
  folderId: string,
): number {
  const childrenByParent = new Map<string, string[]>();
  for (const f of folders) {
    if (!f.parentId) continue;
    const list = childrenByParent.get(f.parentId) ?? [];
    list.push(f.id);
    childrenByParent.set(f.parentId, list);
  }
  let count = 0;
  const seen = new Set<string>([folderId]);
  const stack = [...(childrenByParent.get(folderId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    count += 1;
    stack.push(...(childrenByParent.get(id) ?? []));
  }
  return count;
}

/**
 * Walk a folder's `parentId` chain (via the `parentById` lookup) and return the id of its NEAREST
 * ancestor that is restricted (its id is in `restrictedFolderIds`), or `null` when no ancestor is
 * restricted. Pure and framework-agnostic — shared by the tree's inherited-restriction padlock and
 * the rule editor's headline so both read inheritance the same way (#414).
 *
 * PRESENTATION ONLY: inheritance is computed client-side from the parentId chain + the set of folders
 * carrying an OWN rule. It mirrors (never asserts) the backend's INV-9 enforcement — the server is the
 * sole authority on access. A malformed cycle is bounded by a visited set so it always terminates.
 */
export function restrictedAncestorOf(
  folderId: string,
  parentById: Map<string, string | null>,
  restrictedFolderIds: ReadonlySet<string>,
): string | null {
  let cursor = parentById.get(folderId) ?? null;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    if (restrictedFolderIds.has(cursor)) return cursor;
    cursor = parentById.get(cursor) ?? null;
  }
  return null;
}
