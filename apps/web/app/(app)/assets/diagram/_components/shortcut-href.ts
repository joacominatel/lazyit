import { hasBrowserInterpretedScheme } from "@lazyit/shared";

/** The href for a node shortcut, or `null` when it must render as plain text (SEC-086). */
export function shortcutHref(url: string): string | null {
  // Rows stored before the write guard can still hold javascript:/data: URLs.
  return hasBrowserInterpretedScheme(url) ? null : url;
}
