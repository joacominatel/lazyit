/**
 * i18n single source of truth (ADR-0051).
 *
 * Cookie-mode locale selection — no `/es/` URL prefix, no i18n routing. The active
 * locale is carried in the `NEXT_LOCALE` cookie and read per-request in
 * `i18n/request.ts`. Keep this file framework-agnostic (no `next/*` imports) so it
 * can be shared by the request config, the server action and the switcher UI.
 */

/** The locales lazyit ships. English is the default/fallback (`en` first). */
export const locales = ["en", "es"] as const;

export type Locale = (typeof locales)[number];

/** Fallback when the cookie is missing or holds an unknown value. */
export const defaultLocale: Locale = "en";

/**
 * Cookie that carries the active locale. `NEXT_LOCALE` is next-intl's documented
 * convention and what its examples read by default — keeping the name aligned avoids
 * surprises if we ever adopt i18n routing later.
 */
export const LOCALE_COOKIE = "NEXT_LOCALE";

/** Human-readable label for each locale (used by the switcher). */
export const localeLabels: Record<Locale, string> = {
  en: "English",
  es: "Español",
};

/** Narrow an untrusted string (cookie value, form input) to a supported `Locale`. */
export function isLocale(value: string | undefined | null): value is Locale {
  return value != null && (locales as readonly string[]).includes(value);
}

/**
 * Shared date/time presets (issue #497) — referenced by name through `useFormatter().dateTime(iso,
 * "short")` / `getFormatter().dateTime(iso, "long")` so every table column and its hover tooltip
 * render the date the SAME way for a given locale. Wired into the per-request config in
 * `i18n/request.ts` (Server Components) and forwarded to Client Components via
 * `NextIntlClientProvider`'s `formats` prop (`app/providers.tsx`) so client and server agree.
 *
 * Lives here (not in `request.ts`) so the client-side provider can import it WITHOUT dragging
 * `next/headers` — a Server-only module — into the client bundle.
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
