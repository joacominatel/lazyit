"use client";

import { useCallback, useSyncExternalStore } from "react";
import { useCurrentUser } from "@/lib/api/hooks/use-users";
import {
  clearRecent,
  parseRecent,
  type RecentArticle,
  readRecentRaw,
  recentStorageKey,
  recordRecent,
  subscribeRecent,
} from "@/lib/utils/kb-recent";

const EMPTY: RecentArticle[] = [];

// `useSyncExternalStore` needs a referentially stable snapshot: re-parse only when the raw stored
// string changes, keyed per storage key.
const snapshotCache = new Map<string, { raw: string | null; value: RecentArticle[] }>();

function snapshotFor(key: string): RecentArticle[] {
  const raw = readRecentRaw(key);
  const cached = snapshotCache.get(key);
  if (cached && cached.raw === raw) return cached.value;
  const value = raw ? parseRecent(raw) : EMPTY;
  snapshotCache.set(key, { raw, value });
  return value;
}

/**
 * The viewer's KB "Recent" list (#1539), read from this browser's `localStorage` and scoped to the
 * signed-in user. Renders the empty list on the server and until the current user resolves, so there
 * is no hydration mismatch; updates live when an article is opened (in this tab or another).
 */
export function useRecentArticles() {
  const { data: me } = useCurrentUser();
  const key = me?.id ? recentStorageKey(me.id) : null;

  const items = useSyncExternalStore(
    subscribeRecent,
    () => (key ? snapshotFor(key) : EMPTY),
    () => EMPTY,
  );

  const record = useCallback(
    (entry: Omit<RecentArticle, "openedAt">) => {
      if (key) recordRecent(key, entry);
    },
    [key],
  );

  const clear = useCallback(() => {
    if (key) clearRecent(key);
  }, [key]);

  return { items, record, clear, ready: key !== null };
}
