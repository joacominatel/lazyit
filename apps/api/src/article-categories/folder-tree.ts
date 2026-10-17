// Every tree-shape write checks and writes under this lock, or two opposing moves both pass and close a cycle.
export const FOLDER_TREE_LOCK = 'lazyit.folder_tree';

/** The two columns a folder-tree walk needs: the folder's id and its parent (null for a root). */
export interface FolderTreeEdge {
  id: string;
  parentId: string | null;
}

/**
 * Expand each of `rootIds` to the folder **plus every descendant** found in `folders` (#1539, the
 * `GET /articles?includeSubfolders=true` widening). Pure: the caller loads the live folder list once
 * (`id`, `parentId`) and this walks it in memory, so a subtree of any depth costs one query, not one per
 * level.
 *
 * - Every root is returned, whether or not it appears in `folders` (the caller's filter already named it;
 *   a root that is not live simply matches no live article). A root missing from `folders` is NOT
 *   expanded: a live child restored under a soft-deleted parent is not reached through that parent.
 * - Descendants are only those reachable through `folders`. Pass the LIVE folders, and a soft-deleted
 *   folder is never reached, which also cuts off anything filed under it.
 * - Cycle-safe: a folder already collected is never expanded twice, so a corrupt `parentId` loop ends.
 *
 * Returns the de-duplicated ids, roots first in their given order, then descendants breadth-first.
 */
export function expandFolderSubtrees(
  rootIds: readonly string[],
  folders: readonly FolderTreeEdge[],
): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const folder of folders) {
    if (folder.parentId === null) continue;
    const siblings = childrenOf.get(folder.parentId);
    if (siblings) siblings.push(folder.id);
    else childrenOf.set(folder.parentId, [folder.id]);
  }

  const known = new Set(folders.map((folder) => folder.id));
  const collected = new Set<string>();
  const queue: string[] = [];
  for (const id of rootIds) {
    if (collected.has(id)) continue;
    collected.add(id);
    if (known.has(id)) queue.push(id);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const child of childrenOf.get(queue[cursor]) ?? []) {
      if (collected.has(child)) continue;
      collected.add(child);
      queue.push(child);
    }
  }
  return [...collected];
}

/**
 * Each folder's own count plus every descendant's (#1651), in one pass over rows already loaded. A folder
 * missing from `own` adds 0; an ancestor missing from `folders` stops the walk, as in expandFolderSubtrees.
 */
export function rollUpFolderCounts(
  folders: readonly FolderTreeEdge[],
  own: ReadonlyMap<string, number>,
): Map<string, number> {
  const parentOf = new Map(folders.map((f) => [f.id, f.parentId]));
  const totals = new Map<string, number>();
  for (const folder of folders) {
    const count = own.get(folder.id) ?? 0;
    const visited = new Set<string>();
    let cursor: string | null | undefined = folder.id;
    while (cursor != null && parentOf.has(cursor) && !visited.has(cursor)) {
      visited.add(cursor);
      totals.set(cursor, (totals.get(cursor) ?? 0) + count);
      cursor = parentOf.get(cursor);
    }
  }
  return totals;
}
