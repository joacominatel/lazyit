"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The four author-editable fields of a KB article, mirrored from the form values. Kept local (not
 * imported from the form) so this hook stays a self-contained, framework-agnostic storage helper.
 */
export type ArticleDraftValues = {
  title: string;
  categoryId: string;
  excerpt?: string;
  content: string;
};

export type StoredArticleDraft = {
  values: ArticleDraftValues;
  /** Epoch millis of the last local autosave — surfaced in the "restore draft" prompt. */
  savedAt: number;
};

const STORAGE_PREFIX = "lazyit:kb-draft:";
/** Trailing-edge throttle window for local autosaves (issue #816): a crash loses at most this long. */
const AUTOSAVE_THROTTLE_MS = 2000;

function storageKey(slug: string | undefined): string {
  return `${STORAGE_PREFIX}${slug && slug.length > 0 ? slug : "new"}`;
}

/** Excerpt normalises ""/undefined as equal; the four fields otherwise compare by value. */
function sameValues(a: ArticleDraftValues, b: ArticleDraftValues): boolean {
  return (
    a.title === b.title &&
    a.categoryId === b.categoryId &&
    a.content === b.content &&
    (a.excerpt ?? "") === (b.excerpt ?? "")
  );
}

/** Parse a stored draft defensively — any malformed/oversized blob is treated as absent. */
function readStoredDraft(key: string): StoredArticleDraft | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredArticleDraft>;
    const v = parsed?.values as Partial<ArticleDraftValues> | undefined;
    if (!v || typeof v !== "object") return null;
    return {
      values: {
        title: typeof v.title === "string" ? v.title : "",
        categoryId: typeof v.categoryId === "string" ? v.categoryId : "",
        excerpt: typeof v.excerpt === "string" ? v.excerpt : undefined,
        content: typeof v.content === "string" ? v.content : "",
      },
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export type UseArticleDraft = {
  /** A previously-saved local draft that DIFFERS from the server/empty baseline, or null. */
  restorable: StoredArticleDraft | null;
  /** Hide the restore prompt without touching localStorage (the draft stays as a safety net). */
  dismissRestore: () => void;
  /** Push the latest form values; persisted (or cleared if equal to baseline) on a throttle. */
  queueSave: (values: ArticleDraftValues) => void;
  /** Remove the stored draft (call on a successful save, or an explicit discard). */
  clearDraft: () => void;
};

/**
 * Local draft persistence + periodic autosave for KB article authoring (issue #816). The draft is a
 * client-only safety net — never a server write — so closing the tab, reloading or an accidental
 * navigation no longer silently discards in-progress work. It is keyed by article slug (or "new"),
 * restored on mount via an explicit "restore / discard" prompt (we never auto-clobber the loaded
 * server article), and cleared on a successful save.
 *
 * Pair with {@link useBeforeUnloadGuard} for hard-navigation prompts; in-app navigations the App
 * Router can't intercept (breadcrumb/sidebar/preview links) are covered by this draft surviving.
 */
export function useArticleDraft(
  slug: string | undefined,
  baseline: ArticleDraftValues,
): UseArticleDraft {
  const key = storageKey(slug);

  // Latest baseline/key held in refs so the throttle callbacks never re-subscribe on each edit.
  // Synced via an effect (not during render) — the callbacks only fire post-commit (timer/pagehide).
  const baselineRef = useRef(baseline);
  const keyRef = useRef(key);
  useEffect(() => {
    baselineRef.current = baseline;
    keyRef.current = key;
  }, [baseline, key]);

  const pendingRef = useRef<ArticleDraftValues | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const values = pendingRef.current;
    if (!values) return;
    pendingRef.current = null;
    try {
      if (sameValues(values, baselineRef.current)) {
        window.localStorage.removeItem(keyRef.current);
      } else {
        const payload: StoredArticleDraft = { values, savedAt: Date.now() };
        window.localStorage.setItem(keyRef.current, JSON.stringify(payload));
      }
    } catch {
      // localStorage unavailable or over quota — drafts are best-effort, never block authoring.
    }
  }, []);

  const queueSave = useCallback(
    (values: ArticleDraftValues) => {
      pendingRef.current = values;
      if (timerRef.current == null) {
        timerRef.current = setTimeout(flush, AUTOSAVE_THROTTLE_MS);
      }
    },
    [flush],
  );

  // Flush a pending draft if the page is being hidden/closed, and on unmount.
  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [flush]);

  const clearDraft = useCallback(() => {
    pendingRef.current = null;
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    try {
      window.localStorage.removeItem(keyRef.current);
    } catch {
      // ignore — nothing to recover from a failed remove.
    }
  }, []);

  // Restore prompt: read once per key (mount / slug change), offering only a draft that actually
  // differs from the baseline so a clean form never shows a stale prompt.
  const [restorable, setRestorable] = useState<StoredArticleDraft | null>(null);
  useEffect(() => {
    const stored = readStoredDraft(key);
    setRestorable(
      stored && !sameValues(stored.values, baselineRef.current) ? stored : null,
    );
  }, [key]);

  const dismissRestore = useCallback(() => setRestorable(null), []);

  return { restorable, dismissRestore, queueSave, clearDraft };
}
