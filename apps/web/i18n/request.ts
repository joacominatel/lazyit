import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { defaultLocale, isLocale, LOCALE_COOKIE } from "./config";

/**
 * Per-request next-intl configuration (ADR-0051). Cookie-mode, no i18n routing: the
 * active locale comes from the `NEXT_LOCALE` cookie, defaulting to `en` when the
 * cookie is absent or holds an unsupported value. This file is referenced by the
 * `createNextIntlPlugin` wrap in `next.config.ts`.
 *
 * The catalog is split one file per top-level namespace under
 * `messages/<locale>/<area>.json` and composed by the per-locale barrel
 * `messages/<locale>/_all.ts` (so the section-translation fan-out can edit
 * disjoint files without collisions — see `docs/04-development/i18n.md`). The
 * assembled catalog is handed to Server Components (via `getTranslations`) and
 * to Client Components (via the messages passed into `NextIntlClientProvider` in
 * `app/providers.tsx`).
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const cookieValue = store.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(cookieValue) ? cookieValue : defaultLocale;

  return {
    locale,
    messages: (await import(`../messages/${locale}/_all`)).default,
    formats: SHARED_FORMATS,
  };
});

/**
 * Shared date/time presets (issue #497) — referenced by name through `useFormatter().dateTime(iso,
 * "short")` / `getFormatter().dateTime(iso, "long")` so every table column and its hover tooltip
 * render the date the SAME way for a given locale. Forwarded to Client Components via
 * `NextIntlClientProvider`'s `formats` prop (`app/providers.tsx`) so client and server agree.
 *
 *  - `short`: a compact, locale-aware date ("May 25, 2026" · "25 may 2026") for table columns.
 *  - `long`: the absolute date + time ("May 25, 2026, 3:04 PM") used as the tooltip/aria companion
 *    to a relative time so an audit-relevant row always carries the exact moment it occurred (#311).
 */
export const SHARED_FORMATS = {
  dateTime: {
    short: {
      year: "numeric",
      month: "short",
      day: "numeric",
    },
    long: {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    },
  },
} as const;
