"use client";

import { useSyncExternalStore } from "react";

/** No external store to watch — the value never changes after hydration, so the subscribe is a no-op. */
const emptySubscribe = () => () => {};

/**
 * `true` once the component has hydrated on the client; `false` during SSR **and on the first client
 * render**. Built on `useSyncExternalStore` (server snapshot `false`, client snapshot `true`) — the
 * idiomatic React 19 way to read a hydration-safe mounted flag with no `setState`-in-effect, so it
 * stays lint-clean under the React Compiler rules (mirrors {@link useLocalStorage}'s `mounted`).
 *
 * Use it to gate anything the SERVER could not know — chiefly a value read from a client-only React
 * Query cache that may be WARM on the client but is always cold on the server. Gating such a value on
 * `mounted` keeps the server HTML and the first client render tree identical (no hydration mismatch),
 * then reveals the real value on the next (post-hydration) render.
 *
 * The caller's own `/users/me` and `/config/my-permissions` are already gated at the source (their
 * hooks go through `useClientOnlyQuery`, #1448), so `usePermissions` / `useMyPermissions` / `useCan`
 * need no extra `mounted` check. `/config/status` is prefetched on `/settings/instance`, so its plain
 * hook is not gated; elsewhere read it through `useClientOnlyConfigStatus`.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false,
  );
}
