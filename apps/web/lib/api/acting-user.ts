import { useSyncExternalStore } from "react";

/**
 * Dev-only "acting user" store for the `X-User-Id` auth shim (ADR-0022). Real
 * auth is deferred (ADR-0016), so until an IdP lands the KB authorization model
 * needs a caller identity: this holds the chosen `User.id` in `localStorage`,
 * `apiFetch` attaches it as `X-User-Id`, and the topbar `<UserSwitcher>` lets you
 * change it to test draft visibility. When auth arrives this is replaced by the
 * session — the header and this module go away, the KB code does not.
 */

const STORAGE_KEY = "lazyit.actingUserId";
const CHANGE_EVENT = "lazyit:acting-user-change";

/** Current acting user id, or `undefined` (anonymous → sees only PUBLISHED). */
export function getActingUserId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage.getItem(STORAGE_KEY) ?? undefined;
}

/** Set (or clear, with `undefined`) the acting user and notify subscribers. */
export function setActingUserId(id: string | undefined): void {
  if (typeof window === "undefined") return;
  if (id) {
    window.localStorage.setItem(STORAGE_KEY, id);
  } else {
    window.localStorage.removeItem(STORAGE_KEY);
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback); // sync across tabs
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

/** Reactive read of the acting user id, for UI that reflects the current shim. */
export function useActingUserId(): string | undefined {
  return useSyncExternalStore(
    subscribe,
    getActingUserId,
    () => undefined, // server snapshot: no acting user during SSR
  );
}
