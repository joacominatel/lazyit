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
