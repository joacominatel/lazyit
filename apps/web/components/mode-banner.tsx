"use client";

import {
  BeakerIcon,
  ShieldCheckIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useCallback, useSyncExternalStore } from "react";
import { useConfigStatus } from "@/lib/api/hooks/use-config-status";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * Topbar mode banner (ADR-0043 §7a). Reflects the instance's auth posture so "am I running a real
 * auth stack?" is obvious at a glance and a dev posture is never shipped by accident:
 *   - devMode (AUTH_MODE=shim or NODE_ENV!=production) → a "Dev Mode" banner in the `warning` tone.
 *   - otherwise → a "Production" banner in the `info` tone.
 *
 * Colors use the semantic `--warning`/`--info` design tokens (text-warning / bg-warning/10, etc.)
 * rather than raw amber/blue palette classes, so the posture tones stay consistent with the rest of
 * the design system and adapt to light/dark via the tokens themselves.
 *
 * Dismissible per browser session (sessionStorage) so it reappears on a fresh session but does not
 * nag within one. Responsive: the label collapses to icon-only on narrow screens. Renders nothing
 * until status loads (no flash) and never blocks the topbar.
 */
const DISMISS_KEY = "lazyit:mode-banner-dismissed";

/** Notify subscribers when the per-session dismissal flips (a custom event the dismiss handler fires). */
const DISMISS_EVENT = "lazyit:mode-banner-dismiss";

function subscribe(onChange: () => void): () => void {
  window.addEventListener(DISMISS_EVENT, onChange);
  return () => window.removeEventListener(DISMISS_EVENT, onChange);
}

/** Client snapshot: read the per-session dismissal from sessionStorage. */
function getSnapshot(): boolean {
  return sessionStorage.getItem(DISMISS_KEY) === "1";
}

/** Server snapshot: treat as dismissed so the banner only ever renders after hydration (no flash). */
function getServerSnapshot(): boolean {
  return true;
}

export function ModeBanner() {
  const t = useTranslations("shared");
  const { data: status } = useConfigStatus();
  // useSyncExternalStore reads the per-session dismissal without a setState-in-effect — the idiomatic
  // React 19 pattern for subscribing to an external store (here, sessionStorage + a custom event).
  const dismissed = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const dismiss = useCallback(() => {
    sessionStorage.setItem(DISMISS_KEY, "1");
    window.dispatchEvent(new Event(DISMISS_EVENT));
  }, []);

  if (!status || dismissed) {
    return null;
  }

  const dev = status.devMode;

  const Icon = dev ? BeakerIcon : ShieldCheckIcon;

  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium",
        dev
          ? "border-warning/30 bg-warning/10 text-warning"
          : "border-info/30 bg-info/10 text-info",
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="hidden sm:inline">
        {dev ? t("chrome.devMode") : t("chrome.production")}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={dismiss}
        aria-label={t("chrome.dismissModeBanner")}
        className={cn(
          "-mr-1 ml-0.5 size-4",
          dev ? "hover:bg-warning/20" : "hover:bg-info/20",
        )}
      >
        <XMarkIcon className="size-3" />
      </Button>
    </div>
  );
}
