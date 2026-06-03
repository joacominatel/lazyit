import { useEffect } from "react";

/**
 * Warn the user before they LEAVE the page (close the tab, reload, or navigate away via the browser)
 * while `enabled` is true — the standard `beforeunload` confirmation. Used by forms with unsaved edits
 * (e.g. the role permissions editor) so a half-finished change isn't lost to an accidental reload.
 *
 * Scope note: this covers hard navigations (close/reload/address-bar). In-app navigations via the
 * Next.js router are NOT intercepted here (the App Router has no stable navigation-guard API yet) — a
 * screen that needs that pairs this with an explicit confirm on its own discard/leave controls.
 */
export function useBeforeUnloadGuard(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Legacy requirement for the native prompt in some browsers.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [enabled]);
}
