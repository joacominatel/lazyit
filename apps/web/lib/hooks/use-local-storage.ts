"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * SSR-safe `localStorage`-backed state, built on `useSyncExternalStore` — the idiomatic React 19
 * pattern for subscribing to an external store (mirrors {@link ModeBanner}, which reads
 * sessionStorage the same way). No `setState`-in-effect, so it stays lint-clean under the React
 * Compiler rules.
 *
 * Returns `[value, setValue, mounted]`:
 *   - On the server and the first client paint the **server snapshot** returns `initial`, so the
 *     server and client trees agree (localStorage doesn't exist during SSR). After hydration the
 *     client snapshot reads the persisted value and the component re-renders.
 *   - `mounted` is `false` until hydration completes — consumers that must not flash the default
 *     (e.g. a textarea pre-filled from storage) can gate on it.
 *
 * `value` is JSON-serialized. `setValue` takes a value or an updater (like `useState`) and writes
 * through to `localStorage`, then notifies subscribers (this tab) via a custom event; other tabs are
 * picked up via the native `storage` event. Storage failures (private mode, quota, disabled) are
 * swallowed — the read simply falls back to `initial`.
 *
 * @param key      Namespaced storage key, e.g. `"lazyit:offboarding:message"`.
 * @param initial  The value used before mount and when nothing is stored / parsing fails.
 */
export function useLocalStorage<T>(
  key: string,
  initial: T,
): [T, (next: T | ((prev: T) => T)) => void, boolean] {
  const subscribe = useCallback(
    (onChange: () => void) => {
      // Cross-tab writes (native) + same-tab writes (our custom event) both invalidate the snapshot.
      const onCustom = () => onChange();
      window.addEventListener("storage", onCustom);
      window.addEventListener(localEventName(key), onCustom);
      return () => {
        window.removeEventListener("storage", onCustom);
        window.removeEventListener(localEventName(key), onCustom);
      };
    },
    [key],
  );

  // The raw string snapshot is stable while storage is unchanged — so useSyncExternalStore's
  // Object.is check doesn't loop. We parse it (memoized on the raw string) outside the store.
  const getRawSnapshot = useCallback((): string | null => {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }, [key]);

  // Server / pre-hydration snapshot: null means "use initial", and is what keeps SSR consistent.
  const getServerSnapshot = useCallback((): string | null => null, []);

  const raw = useSyncExternalStore(subscribe, getRawSnapshot, getServerSnapshot);

  // `mounted` flips once the client snapshot (which may still be null when nothing is stored) is in
  // play. useSyncExternalStore returns the server snapshot only during SSR/first paint, so a second
  // store read that differs by reference is what marks hydration — we approximate it by comparing to
  // the server snapshot identity, which is the documented contract of the hook.
  const mounted = useSyncExternalStore(
    subscribe,
    useCallback(() => true, []),
    useCallback(() => false, []),
  );

  const value = useMemo<T>(() => {
    if (raw === null) return initial;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return initial;
    }
    // `initial` is the caller's stable default; re-parsing only when the raw string changes is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      let prev: T;
      try {
        const current = window.localStorage.getItem(key);
        prev = current === null ? initial : (JSON.parse(current) as T);
      } catch {
        prev = initial;
      }
      const resolved =
        typeof next === "function" ? (next as (prev: T) => T)(prev) : next;
      try {
        window.localStorage.setItem(key, JSON.stringify(resolved));
        // Notify this tab's subscribers (the native `storage` event only fires in OTHER tabs).
        window.dispatchEvent(new Event(localEventName(key)));
      } catch {
        // Persisting failed (quota / disabled) — nothing to sync; the next read falls back to initial.
      }
    },
    // `initial` is a stable default supplied by the caller; keying on `key` is sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  return [value, set, mounted];
}

/** Per-key custom event so a same-tab write to one key doesn't wake hooks bound to another. */
function localEventName(key: string): string {
  return `lazyit:localstorage:${key}`;
}
