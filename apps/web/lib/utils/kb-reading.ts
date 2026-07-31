import type { Folder } from "@lazyit/shared";

/**
 * Pure derivations for the calm KB reading view (#1106 Phase 2). Both are framework-agnostic
 * projections over data the reading page already loaded (the folder list, the folder's articles) —
 * no new endpoint, no DOM — so they are unit-tested directly (`kb-reading.test.ts`).
 */

/**
 * The ordered folder chain from the ROOT down to (and including) the article's HOME folder — the full
 * breadcrumb path ("Runbooks / Networking / VPN"). Walks the `parentId` chain via a `folderById`
 * lookup and reverses to root→leaf order. Cycle-guarded (a folder transitively its own ancestor stops
 * the walk) so malformed data can never hang the UI. Returns an empty array when the home folder is
 * unknown or soft-deleted (a legacy category that never appears in the live list) — the caller then
 * shows just the "Knowledge Base" root crumb, never a broken trail.
 */
export function articleFolderTrail(
  homeFolderId: string | null | undefined,
  folders: Folder[],
): Folder[] {
  if (!homeFolderId) return [];
  const byId = new Map(folders.map((f) => [f.id, f]));
  const home = byId.get(homeFolderId);
  if (!home) return [];
  const chain: Folder[] = [home];
  const seen = new Set<string>([home.id]);
  let parentId = home.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    chain.push(parent);
    parentId = parent.parentId;
  }
  return chain.reverse();
}

/** A minimal reference to a sibling article — what the prev/next footer needs to render a link. */
export interface ArticleSiblingRef {
  slug: string;
  title: string;
}

/** The prev/next neighbours of the current article among its folder siblings. */
export interface ArticleSiblings {
  prev: ArticleSiblingRef | null;
  next: ArticleSiblingRef | null;
}

/**
 * The prev/next neighbours of `currentId` among its folder siblings, ordered by title (locale-aware,
 * case-insensitive) so the "← DNS records · Firewall rules →" footer is deterministic regardless of
 * the list endpoint's paging order. A neighbour is `null` at either end of the folder, and both are
 * `null` when the current article isn't in the supplied set (e.g. it paged out of a large folder).
 * Pure — the caller passes the already-loaded folder article list (zero new endpoint).
 */
export function articleSiblings<
  T extends { id: string; slug: string; title: string },
>(articles: T[], currentId: string): ArticleSiblings {
  const sorted = [...articles].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  );
  const index = sorted.findIndex((a) => a.id === currentId);
  if (index === -1) return { prev: null, next: null };
  const toRef = (a: T | undefined): ArticleSiblingRef | null =>
    a ? { slug: a.slug, title: a.title } : null;
  return { prev: toRef(sorted[index - 1]), next: toRef(sorted[index + 1]) };
}
