import { useSyncExternalStore } from "react";

/** The page's own address — never changes while the page lives, so there is nothing to subscribe to. */
function subscribe(): () => void {
  return () => {};
}

function getSnapshot(): string {
  return window.location.href;
}

function getServerSnapshot(): null {
  return null;
}

/**
 * The page's origin and protocol, read after hydration (null during SSR and the first paint) so the
 * server and client render the same markup. Every install snippet derives from it: lazyit is
 * self-hosted and domain-portable, so nothing is baked at build time.
 */
export function usePageLocation(): { origin: string; protocol: string } | null {
  const href = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  if (href === null) return null;
  const url = new URL(href);
  return { origin: url.origin, protocol: url.protocol };
}
