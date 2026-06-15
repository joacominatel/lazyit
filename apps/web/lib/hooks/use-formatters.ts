"use client";

import { useFormatter, useNow } from "next-intl";
import { useCallback } from "react";

/**
 * Locale-aware date/time + relative-time formatting for Client Components (issue #497).
 *
 * Wraps next-intl's `useFormatter()` (which reads the active `NEXT_LOCALE`, ADR-0051) + `useNow()`
 * so every relative time ("5m ago" / "hace 5 min") and absolute stamp honours the user's locale
 * instead of the runtime default. Replaces the old `formatDate`/`formatDateTime`/`formatRelativeTime`
 * helpers, which passed `undefined` as the locale (server default, usually `en-US`) and hard-coded
 * the relative-time grammar in English.
 *
 * `useNow()` supplies the render-stable "now" reference (a global value re-evaluated on the
 * `updateInterval`), so call sites no longer thread a `useState(() => Date.now())` snapshot just to
 * keep relative times pure — they stay pure here, and tick on their own.
 *
 * The absolute presets (`short` / `long`) come from the shared `formats` config (`i18n/request.ts`),
 * so a table column and its hover tooltip render the date identically for a given locale.
 */
export function useFormatters() {
  const format = useFormatter();
  // Refresh relative times each minute so a "just now" row ages to "1m ago" without a reload, while
  // staying cheap (the bell/feed already re-render on their own polling).
  const now = useNow({ updateInterval: 60 * 1000 });

  /** ISO timestamp → a compact, locale-aware date ("May 25, 2026" · "25 may 2026"). */
  const date = useCallback(
    (iso: string) => format.dateTime(new Date(iso), "short"),
    [format],
  );

  /** ISO timestamp → an absolute, locale-aware date + time, used as the relative-time tooltip/aria. */
  const dateTime = useCallback(
    (iso: string) => format.dateTime(new Date(iso), "long"),
    [format],
  );

  /** ISO timestamp → a short, locale-aware relative label ("5m ago" · "hace 5 min"). */
  const relative = useCallback(
    (iso: string) => format.relativeTime(new Date(iso), now),
    [format, now],
  );

  return { date, dateTime, relative };
}
