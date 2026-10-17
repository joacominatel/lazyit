/**
 * The KB "Recent" list (#1539): the articles this viewer opened in THIS browser, newest first. It is a
 * per-viewer convenience kept in `localStorage` — never sent to the server, never shared between
 * browsers or people — so it needs no backend and degrades to an empty list wherever storage is
 * unavailable (a private window, blocked site data, a sandboxed preview). Every storage access is
 * wrapped in try/catch for that reason.
 *
 * The key is scoped per signed-in user, so two people sharing a browser profile do not see each other's
 * reading history. An entry holds only what a list row needs: slug, title, home folder and when it
 * was opened. A stale entry (renamed, moved, deleted or no longer readable) is harmless: the title
 * refreshes on the next open, and a link the viewer may no longer follow simply returns "not found".
 *
 * The pure half (`parseRecent`, `addRecent`) is unit-tested; the storage half is thin and tolerant.
 */

/** One recently-opened article. */
export interface RecentArticle {
  slug: string;
  title: string;
  /** The article's home folder when it was opened; `null` when unknown. */
  categoryId: string | null;
  /** ISO timestamp of the last open. */
  openedAt: string;
}

/** How many entries the list keeps. */
export const RECENT_LIMIT = 20;

/** Storage key prefix; bump the version if the entry shape ever changes incompatibly. */
export const RECENT_STORAGE_PREFIX = "lazyit.kb.recent.v1";

/** The storage key for one signed-in user. */
export function recentStorageKey(userId: string): string {
  return `${RECENT_STORAGE_PREFIX}:${userId}`;
}

function isRecentArticle(value: unknown): value is RecentArticle {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.slug === "string" &&
    entry.slug.length > 0 &&
    typeof entry.title === "string" &&
    (entry.categoryId === null || typeof entry.categoryId === "string") &&
    typeof entry.openedAt === "string" &&
    !Number.isNaN(Date.parse(entry.openedAt))
  );
}

/**
 * Parse a stored value into a clean list: invalid JSON or a non-array yields `[]`, invalid entries are
 * dropped, duplicates keep their newest occurrence, and the result is newest first and capped.
 */
export function parseRecent(raw: string | null | undefined): RecentArticle[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const entries = value
    .filter(isRecentArticle)
    .map(({ slug, title, categoryId, openedAt }) => ({ slug, title, categoryId, openedAt }))
    .sort((a, b) => Date.parse(b.openedAt) - Date.parse(a.openedAt));
  const seen = new Set<string>();
  const out: RecentArticle[] = [];
  for (const entry of entries) {
    if (seen.has(entry.slug)) continue;
    seen.add(entry.slug);
    out.push(entry);
    if (out.length === RECENT_LIMIT) break;
  }
  return out;
}

/** Put `entry` first (replacing an earlier open of the same slug) and cap the list. */
export function addRecent(
  list: readonly RecentArticle[],
  entry: Omit<RecentArticle, "openedAt">,
  now: Date,
): RecentArticle[] {
  const next: RecentArticle = {
    slug: entry.slug,
    title: entry.title,
    categoryId: entry.categoryId ?? null,
    openedAt: now.toISOString(),
  };
  return [next, ...list.filter((item) => item.slug !== entry.slug)].slice(0, RECENT_LIMIT);
}

// --- storage ---------------------------------------------------------------------------------------

/** The slice of `Storage` this module uses (injectable for tests). */
export interface RecentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `window.localStorage`, or `null` when there is no window or the accessor throws. */
function browserStorage(): RecentStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to changes made in this tab and, through the `storage` event, in other tabs. */
export function subscribeRecent(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(RECENT_STORAGE_PREFIX)) listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

/** The raw stored string for `key`, or `null` when absent or unreadable. */
export function readRecentRaw(
  key: string,
  storage: RecentStorage | null = browserStorage(),
): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** The stored list for `key` (empty when storage is unavailable). */
export function readRecent(
  key: string,
  storage: RecentStorage | null = browserStorage(),
): RecentArticle[] {
  return parseRecent(readRecentRaw(key, storage));
}

/** Record an open. Returns the new list; a failed write leaves the page working, just unrecorded. */
export function recordRecent(
  key: string,
  entry: Omit<RecentArticle, "openedAt">,
  storage: RecentStorage | null = browserStorage(),
  now: Date = new Date(),
): RecentArticle[] {
  const next = addRecent(readRecent(key, storage), entry, now);
  try {
    storage?.setItem(key, JSON.stringify(next));
  } catch {
    // Quota exceeded or storage blocked: the list simply is not kept.
  }
  notify();
  return next;
}

/** Forget the list for `key`. */
export function clearRecent(
  key: string,
  storage: RecentStorage | null = browserStorage(),
): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Storage blocked: nothing to clear.
  }
  notify();
}
