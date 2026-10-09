/**
 * The order of the KB home's folder cards (#1539). The home shows only a few root folders before "See
 * all", so the ones that hold the most knowledge come first: ranked by the articles filed anywhere in
 * the folder's branch (its own plus every descendant's count), most first. Ties keep the incoming
 * order, which is the tree's own order, so equal folders read the same as in the rail.
 *
 * A count the API withheld (`null` for a folder the viewer can't read, absent on an older API) counts
 * as zero, and a cycle in `childrenById` is walked once.
 */
export interface RankableFolder {
  id: string;
  articleCount?: number | null;
}

/** Articles filed in `folderId` and all its descendants. */
export function branchArticleCount<F extends RankableFolder>(
  folder: F,
  childrenById: ReadonlyMap<string, readonly F[]>,
): number {
  const seen = new Set<string>();
  let total = 0;
  const stack: F[] = [folder];
  while (stack.length > 0) {
    const current = stack.pop() as F;
    if (seen.has(current.id)) continue;
    seen.add(current.id);
    total += current.articleCount ?? 0;
    for (const child of childrenById.get(current.id) ?? []) stack.push(child);
  }
  return total;
}

/** `roots` ordered by branch article count, most first; a stable sort, so ties keep tree order. */
export function rankFolderCards<F extends RankableFolder>(
  roots: readonly F[],
  childrenById: ReadonlyMap<string, readonly F[]>,
): F[] {
  const counts = new Map(roots.map((root) => [root.id, branchArticleCount(root, childrenById)]));
  return roots.toSorted((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0));
}
